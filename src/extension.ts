import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import sharp from 'sharp';

type ImageConfig = {
    path: string;
    compressQuality: number;
    maxWidth: number;
    outputFormat: 'keep' | 'webp';
};

type ImageItem = {
    name: string;
    extension: string;
    buffer: Uint8Array;
};

type TemplateVariables = Record<string, string>;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.tif', '.tiff']);
const IMAGE_EDIT_KIND = vscode.DocumentDropOrPasteEditKind.Text.append('markdown', 'image');

export function activate(context: vscode.ExtensionContext): void {
    // 总体流程：用户触发拖动/粘贴/命令 -> collect去重
    //  -> provider根据配置生成图片链接文本 -> 插入到markdown文档

    // 一个插件只有一个provider
    const provider = new MarkdownImageInsertProvider();

    context.subscriptions.push(
        // 拖动走这个provider，并且只在markdown语言生效
        vscode.languages.registerDocumentDropEditProvider(
            { language: 'markdown' },
            provider,
            { dropMimeTypes: ['files', 'image/*', 'text/uri-list'] }
        )
    );

    context.subscriptions.push(
        // 同样的，粘贴也走这个provider
        vscode.languages.registerDocumentPasteEditProvider(
            { language: 'markdown' },
            provider,
            {
                providedPasteEditKinds: [IMAGE_EDIT_KIND],
                pasteMimeTypes: ['files', 'image/*', 'text/uri-list']
            }
        )
    );

    context.subscriptions.push(
        // 右键和命令面板走这个命令
        // command不需要provider接口，只需要走核心函数
        vscode.commands.registerCommand('mdnote.insertImageFromFile', async () => {
            await provider.insertImageFromFileCommand();
        })
    );
}

export function deactivate(): void {
    return undefined;
}

class MarkdownImageInsertProvider implements vscode.DocumentDropEditProvider, vscode.DocumentPasteEditProvider {
    // Entry 1:
    async provideDocumentDropEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        dataTransfer: vscode.DataTransfer,
        token: vscode.CancellationToken
    ): Promise<vscode.DocumentDropEdit | undefined> {
        // 先构建要插入的文本，然后生成一个 Edit 返回
        const items = await this.collectImageItems(dataTransfer, token);
        const insertText = await this.buildInsertTextFromItems(document, items, token);
        if (!insertText) {
            return undefined;
        }

        return new vscode.DocumentDropEdit(
            new vscode.SnippetString(insertText),
            vscode.l10n.t('Insert compressed image links'),
            IMAGE_EDIT_KIND
        );
    }

    // Entry 2:
    async provideDocumentPasteEdits(
        document: vscode.TextDocument,
        ranges: readonly vscode.Range[],
        dataTransfer: vscode.DataTransfer,
        context: vscode.DocumentPasteEditContext,
        token: vscode.CancellationToken
    ): Promise<vscode.DocumentPasteEdit[] | undefined> {
        // 和拖动类似
        const items = await this.collectImageItems(dataTransfer, token);
        const insertText = await this.buildInsertTextFromItems(document, items, token);
        if (!insertText) {
            return undefined;
        }

        const edit = new vscode.DocumentPasteEdit(
            new vscode.SnippetString(insertText),
            vscode.l10n.t('Paste compressed image links'),
            IMAGE_EDIT_KIND
        );

        // 如果有多个选区range，在每个range插入相同的图片链接。
        // 如果只在第一个range插入：return [edit];
        return ranges.map(() => edit);
    }

    // Entry 3:
    async insertImageFromFileCommand(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'markdown') {
            void vscode.window.showInformationMessage(vscode.l10n.t('Open a Markdown editor before inserting images.'));
            return;
        }

        // 创建窗口选择图片文件，可以多选
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: vscode.l10n.t('Insert Images'),
            filters: {
                Images: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'tif', 'tiff']
            }
        });

        if (!uris || uris.length === 0) {
            return;
        }

        const items = await this.collectImageItemsFromUris(uris);
        const insertText = await this.buildInsertTextFromItems(editor.document, items);
        if (!insertText) {
            void vscode.window.showWarningMessage(vscode.l10n.t('No supported image files were selected.'));
            return;
        }

        // 如果有多个选区range，在每个range插入相同的图片链接。
        // 如果只在第一个range插入：把insertionPoints设置为selection.active
        const insertionPoints = editor.selections.map(selection => selection.active);
        await editor.insertSnippet(new vscode.SnippetString(insertText), insertionPoints);
    }

    private async buildInsertTextFromItems(
        document: vscode.TextDocument,
        items: ImageItem[],
        token?: vscode.CancellationToken
    ): Promise<string | undefined> {
        if (items.length === 0) {
            return undefined;
        }

        const config = this.getConfig(document);
        const workspaceFolder = this.getWorkspaceFolder(document);
        if (!workspaceFolder) {
            void vscode.window.showErrorMessage(vscode.l10n.t('An open workspace folder is required to save inserted images.'));
            return undefined;
        }

        const links: string[] = [];
        for (let index = 0; index < items.length; index += 1) {
            if (token?.isCancellationRequested) {
                return undefined;
            }

            // counter is per operation batch index, not a persisted global counter.
            const item = items[index];
            const sourceName = item.name ?? `image-${index + 1}`;
            const outputFile = await this.writeImage(document, workspaceFolder, config, sourceName, item.buffer, item.extension, index + 1);
            const relativePath = this.toMarkdownRelativePath(document.uri, outputFile);
            const altText = this.toAltText(sourceName);
            links.push(`![${altText}](${this.escapeMarkdownLink(relativePath)})`);
        }

        return links.join('\n');
    }

    private async collectImageItems(dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<ImageItem[]> {
        const results: ImageItem[] = [];
        // Same image may appear in multiple mime channels; hash-based dedupe keeps one copy.
        const seenKeys = new Set<string>();

        for (const [mimeType, item] of dataTransfer) {
            if (mimeType === 'text/uri-list') {
                const raw = await item.asString();
                for (const entry of raw.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
                    try {
                        const uri = vscode.Uri.parse(entry);
                        const fileName = path.basename(uri.fsPath || uri.path);
                        if (!this.isImageName(fileName)) {
                            continue;
                        }
                        const buffer = await vscode.workspace.fs.readFile(uri);
                        this.pushUniqueImage(results, seenKeys, fileName, path.extname(fileName).toLowerCase(), buffer);
                    } catch {
                        continue;
                    }
                }

                continue;
            }

            const file = item.asFile();
            if (!file) {
                continue;
            }

            if (mimeType !== 'files' && !mimeType.startsWith('image/')) {
                continue;
            }

            const buffer = await file.data();
            if (!token.isCancellationRequested && this.isImageName(file.name)) {
                this.pushUniqueImage(results, seenKeys, file.name, path.extname(file.name).toLowerCase(), buffer);
            }
        }

        return results;
    }

    private async collectImageItemsFromUris(uris: vscode.Uri[]): Promise<ImageItem[]> {
        const results: ImageItem[] = [];
        const seenKeys = new Set<string>();

        for (const uri of uris) {
            const fileName = path.basename(uri.fsPath || uri.path);
            if (!this.isImageName(fileName)) {
                continue;
            }

            try {
                const buffer = await vscode.workspace.fs.readFile(uri);
                this.pushUniqueImage(results, seenKeys, fileName, path.extname(fileName).toLowerCase(), buffer);
            } catch {
                continue;
            }
        }

        return results;
    }

    private async writeImage(
        document: vscode.TextDocument,
        workspaceFolder: vscode.Uri,
        config: ImageConfig,
        sourceName: string,
        buffer: Uint8Array,
        extension: string,
        counter: number
    ): Promise<vscode.Uri> {
        // Resolve template variables and split into target folder + base filename.
        const variables = this.createTemplateVariables(document, workspaceFolder, sourceName, counter);
        const output = this.resolveOutputTarget(workspaceFolder, config.path, variables, counter);
        const folderUri = output.folderUri;
        await vscode.workspace.fs.createDirectory(folderUri);

        const baseName = output.baseName;
        const outputExtension = this.resolveOutputExtension(extension, config.outputFormat);
        const outputUri = await this.createUniqueTarget(folderUri, baseName, outputExtension);
        const outputBuffer = await this.compress(buffer, extension, outputExtension, config.compressQuality, config.maxWidth);
        await vscode.workspace.fs.writeFile(outputUri, outputBuffer);
        return outputUri;
    }

    private async createUniqueTarget(folderUri: vscode.Uri, baseName: string, extension: string): Promise<vscode.Uri> {
        // Non-destructive write strategy: if name exists, append -1/-2/... suffix.
        let suffix = 0;
        while (true) {
            const candidateName = suffix === 0 ? `${baseName}${extension}` : `${baseName}-${suffix}${extension}`;
            const candidate = vscode.Uri.joinPath(folderUri, candidateName);
            try {
                await vscode.workspace.fs.stat(candidate);
                suffix += 1;
            } catch {
                return candidate;
            }
        }
    }

    private async compress(buffer: Uint8Array, sourceExtension: string, outputExtension: string, quality: number, maxWidth: number): Promise<Uint8Array> {
        const lower = sourceExtension.toLowerCase();
        if (!IMAGE_EXTENSIONS.has(lower)) {
            return buffer;
        }

        // sharp pipeline is similar to an image processing chain: decode -> rotate -> resize -> encode.
        let pipeline = sharp(buffer).rotate();
        if (maxWidth > 0) {
            pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
        }

        switch (outputExtension.toLowerCase()) {
            case '.webp':
                return await pipeline.webp({ quality }).toBuffer();
            case '.png':
                return await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
            case '.jpg':
            case '.jpeg':
                return await pipeline.jpeg({ quality }).toBuffer();
            case '.avif':
                return await pipeline.avif({ quality }).toBuffer();
            case '.tif':
            case '.tiff':
                return await pipeline.tiff({ compression: 'lzw' }).toBuffer();
            default:
                return buffer;
        }
    }

    private getWorkspaceFolder(document: vscode.TextDocument): vscode.Uri | undefined {
        return vscode.workspace.getWorkspaceFolder(document.uri)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    }

    private getConfig(document: vscode.TextDocument): ImageConfig {
        const config = vscode.workspace.getConfiguration('mdnote', document.uri);
        return {
            path: config.get<string>('path', 'assets/images/img-{date}-{counter}'),
            compressQuality: config.get<number>('compressQuality', 82),
            maxWidth: config.get<number>('maxWidth', 1600),
            outputFormat: config.get<'keep' | 'webp'>('outputFormat', 'keep')
        };
    }

    private pushUniqueImage(
        results: ImageItem[],
        seenKeys: Set<string>,
        name: string,
        extension: string,
        buffer: Uint8Array
    ): void {
        const key = `${name.toLowerCase()}:${createHash('sha1').update(buffer).digest('hex')}`;
        if (seenKeys.has(key)) {
            return;
        }

        seenKeys.add(key);
        results.push({ name, extension, buffer });
    }

    private resolveOutputExtension(sourceExtension: string, outputFormat: 'keep' | 'webp'): string {
        // Users cannot force extension from path template; extension is controlled here.
        if (outputFormat === 'webp') {
            return '.webp';
        }

        return sourceExtension;
    }

    private resolveOutputTarget(
        workspaceFolder: vscode.Uri,
        pathTemplate: string,
        variables: TemplateVariables,
        counter: number
    ): { folderUri: vscode.Uri; baseName: string } {
        // mdnote.path is "folder + filename pattern" in one string.
        const expanded = this.replaceTemplateVariables(pathTemplate, variables).trim() || 'assets/images/img-{date}-{counter}';
        const normalized = expanded.replace(/\\/g, '/');
        const hasTrailingSlash = /\/$/.test(normalized);

        let folderPart = '';
        let filePart = '';
        if (hasTrailingSlash) {
            folderPart = normalized.replace(/\/+$/, '');
            filePart = '';
        } else {
            folderPart = path.posix.dirname(normalized);
            filePart = path.posix.basename(normalized);
            if (folderPart === '.') {
                folderPart = '';
            }
        }

        const folderUri = this.toTargetFolderUri(workspaceFolder, folderPart);
        const baseNamePattern = filePart || 'img-{date}-{counter}';
        const baseName = this.buildFileName(baseNamePattern, counter, variables);
        return { folderUri, baseName };
    }

    private toTargetFolderUri(workspaceFolder: vscode.Uri, folderPart: string): vscode.Uri {
        const normalized = folderPart.replace(/\\/g, '/');
        if (!normalized) {
            return workspaceFolder;
        }

        if (path.isAbsolute(normalized)) {
            return vscode.Uri.file(normalized);
        }

        return vscode.Uri.joinPath(workspaceFolder, ...normalized.split('/').filter(Boolean));
    }

    private buildFileName(pattern: string, counter: number, variables: TemplateVariables): string {
        const now = new Date();
        const date = now.toISOString().slice(0, 10).replace(/-/g, '');
        const time = now.toISOString().slice(11, 19).replace(/:/g, '');

        const expanded = this.replaceTemplateVariables(pattern, variables)
            .replaceAll('{date}', date)
            .replaceAll('{time}', time)
            .replaceAll('{counter}', String(counter).padStart(2, '0'))
            .replaceAll('{name}', variables.fileBaseName ?? 'image');

        // Extension is always controlled by plugin output format, not by user path template.
        const withoutExt = path.parse(expanded).name || expanded;

        const sanitized = withoutExt
            .replace(/[\\/]+/g, '-')
            .replace(/[<>:"|?*\x00-\x1F]/g, '-')
            .replace(/[. ]+$/g, '')
            .trim();

        return sanitized || `image-${String(counter).padStart(2, '0')}`;
    }

    private createTemplateVariables(
        document: vscode.TextDocument,
        workspaceFolder: vscode.Uri,
        sourceName: string,
        counter: number
    ): TemplateVariables {
        const documentFilePath = document.uri.fsPath;
        const documentDirName = path.dirname(documentFilePath);
        const fileExtName = path.extname(sourceName).replace(/^\./, '').toLowerCase();
        const fileName = path.basename(sourceName);
        const picOriginalName = path.basename(sourceName, path.extname(sourceName));
        const fileBaseName = path.basename(sourceName, path.extname(sourceName)).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'image';

        let documentRelativeFilePath = path.relative(workspaceFolder.fsPath, documentFilePath);
        if (!documentRelativeFilePath || documentRelativeFilePath.startsWith('..')) {
            documentRelativeFilePath = documentFilePath;
        }

        const documentRelativeDirName = path.dirname(documentRelativeFilePath);
        const normalizedRelativeDirName = documentRelativeDirName === '.' ? '' : documentRelativeDirName;

        const now = new Date();
        const unixTime = String(Date.now());
        const isoTime = now.toISOString();

        return {
            documentDirName,
            documentRelativeDirName: normalizedRelativeDirName,
            documentFileName: path.basename(documentFilePath),
            documentBaseName: path.basename(documentFilePath, path.extname(documentFilePath)),
            documentExtName: path.extname(documentFilePath).replace(/^\./, ''),
            documentFilePath,
            documentRelativeFilePath,
            documentWorkspaceFolder: workspaceFolder.fsPath,
            fileName,
            picOriginalName,
            fileBaseName,
            fileExtName,
            unixTime,
            isoTime,
            counter: String(counter).padStart(2, '0')
        };
    }

    private replaceTemplateVariables(value: string, variables: TemplateVariables): string {
        return value.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (full, key: string) => {
            return variables[key] ?? full;
        });
    }

    private toMarkdownRelativePath(documentUri: vscode.Uri, targetUri: vscode.Uri): string {
        const documentDir = path.dirname(documentUri.fsPath);
        const relativePath = path.relative(documentDir, targetUri.fsPath);
        return relativePath.split(path.sep).join('/');
    }

    private toAltText(sourceName: string): string {
        return path.basename(sourceName, path.extname(sourceName)).replace(/[_-]+/g, ' ').trim() || 'image';
    }

    private escapeMarkdownLink(value: string): string {
        return value.replace(/\)/g, '\\)').replace(/\(/g, '\\(');
    }

    private isImageName(fileName: string): boolean {
        return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
    }
}
