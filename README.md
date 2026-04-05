# Markdown 图像助手

一个用于 Markdown 编辑的 VS Code 扩展。按住 Shift 拖入图片后，插件会自动压缩图片、保存到已配置目录，并在文档中插入相对路径的 Markdown 图片链接。

## 功能

- 通过 VS Code 的 drop-into-editor 流程，处理 Markdown 编辑器中的拖拽图片。
- 支持将图片内容粘贴到 Markdown 编辑器中。
- 新增命令 `Markdown 图像助手: 从文件插入图片`，无需拖拽或粘贴也可手动插入图片。
- 在 Markdown 文件编辑器右键菜单中新增快捷插图项。
- 保存前会压缩受支持的图片格式。
- 按可配置的命名模式重命名生成文件。
- 在拖拽位置插入相对路径的 Markdown 图片链接。

## 配置项

- `mdnote.path`: 单一模板配置，包含目录和文件名（不含后缀）。后缀始终由插件根据输出格式自动拼接。

路径使用提示：

- 推荐直接把文件名也写进 `mdnote.path`，例如 `${documentRelativeDirName}/assets/${picOriginalName}-{counter}`。
- 即使在 `mdnote.path` 里写了后缀，插件也会忽略该后缀并按 `mdnote.outputFormat` 自动拼接。
- `mdnote.compressQuality`: 受支持压缩格式的压缩质量。
- `mdnote.maxWidth`: 可选的大图宽度限制（超出时会缩放）。
- `mdnote.outputFormat`: 设为 `webp` 可将拖入图片统一转换为 webp，以获得更高压缩率。

支持的模板变量（简化版）：

- `${documentDirName}` Markdown 文件绝对目录
- `${documentRelativeDirName}` Markdown 文件相对工作区目录
- `${documentBaseName}` Markdown 文件名（不含扩展名）
- `${documentWorkspaceFolder}` Markdown 文件所在工作区目录
- `${fileName}` 源图片文件名
- `${picOriginalName}` 源图片原始文件名（不含后缀）
- `${fileExtName}` 源图片扩展名
- `${unixTime}` 当前毫秒时间戳
- `${isoTime}` 当前 ISO 时间字符串

示例：

- `mdnote.path`: `${documentRelativeDirName}/assets/${documentBaseName}/${documentBaseName}-${unixTime}-{counter}`
- `mdnote.path`: `${documentRelativeDirName}/assets/${picOriginalName}-${unixTime}-{counter}`

## 说明

拖拽流程依赖 VS Code 的编辑器拖放能力。请确保启用 `editor.dropIntoEditor.enabled`，并在把文件拖入编辑器时按住 `Shift`。

如果你希望文件体积尽可能小，建议将 `mdnote.outputFormat` 设为 `webp`。这样拖拽流程不变，但输出文件会统一为 webp，而不是保留原始扩展名。

所有插入方式（拖拽、粘贴、命令）共用同一套保存/压缩/重命名处理流程。
