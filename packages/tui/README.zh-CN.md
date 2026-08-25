# @earendil-works/pi-tui

一个极简的终端 UI 框架，提供差量渲染与同步输出，用于构建无闪烁的交互式 CLI 应用。

> 本文件是 [README.md](./README.md) 的中文副本。代码块、接口名和命令保持原样；如中文说明与英文原文存在细微差异，以英文原文为准。

## Features

- **Differential Rendering**：只更新变化的内容，减少重绘
- **Synchronized Output**：利用 CSI 2026 做原子化刷新，避免闪烁
- **Bracketed Paste Mode**：正确处理大段粘贴，并给 10 行以上粘贴加标记
- **Component-based**：基于简单的 `render()` 组件接口
- **Theme Support**：组件可接收主题接口，自定义样式
- **Built-in Components**：内置 `Text`、`TruncatedText`、`Input`、`Editor`、`Markdown`、`Loader`、`SelectList`、`SettingsList`、`Spacer`、`Image`、`Box`、`Container`
- **Inline Images**：支持 Kitty 或 iTerm2 图形协议的终端可直接显示图片
- **Autocomplete Support**：支持路径补全和 slash command 补全

## Quick Start

```typescript
import { TUI, Text, Editor, ProcessTerminal, matchesKey } from "@earendil-works/pi-tui";

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);

tui.addChild(new Text("Welcome to my app!"));

import { defaultEditorTheme as editorTheme } from './test/test-themes.ts';
const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text) => {
  console.log("Submitted:", text);
  tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

tui.setFocus(editor);

tui.addInputListener((data) => {
  if (matchesKey(data, 'ctrl+c')) {
    tui.stop();
    process.exit(0);
  }
});

tui.start();
```

## Core API

### TUI

`TUI` 是主容器，负责组件树、输入分发、焦点与重绘。

```typescript
const tui = new TUI(terminal);
tui.addChild(component);
tui.removeChild(component);
tui.start();
tui.stop();
tui.requestRender();

tui.onDebug = () => console.log("Debug triggered");
```

### Overlays

overlay 会渲染在当前内容上方，不替换底层内容，适合做对话框、菜单、模态层。

```typescript
const handle = tui.showOverlay(component);

const handle = tui.showOverlay(component, {
  width: 60,
  width: "80%",
  minWidth: 40,
  maxHeight: 20,
  maxHeight: "50%",
  anchor: 'bottom-right',
  offsetX: 2,
  offsetY: -1,
  row: "25%",
  col: "50%",
  row: 5,
  col: 10,
  margin: 2,
  margin: { top: 1, right: 2, bottom: 1, left: 2 },
  visible: (termWidth, termHeight) => termWidth >= 100,
  nonCapturing: true
});

handle.hide();
handle.setHidden(true);
handle.setHidden(false);
handle.isHidden();
handle.focus();
handle.unfocus();
handle.unfocus({ target: baseComponent });
handle.unfocus({ target: null });
handle.isFocused();

tui.hideOverlay();
tui.hasOverlay();
```

`anchor` 可用值：

- `'center'`
- `'top-left'`
- `'top-right'`
- `'bottom-left'`
- `'bottom-right'`
- `'top-center'`
- `'bottom-center'`
- `'left-center'`
- `'right-center'`

位置和尺寸的计算顺序：

1. `minWidth` 先作为下限生效
2. 位置优先级：绝对 `row/col` > 百分比 `row/col` > `anchor`
3. `margin` 会把 overlay 限制在终端可见区域内
4. `visible` 在每帧执行，决定当前是否显示

### Component Interface

所有组件都实现以下接口：

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}
```

说明：

- `render(width)`：返回一个字符串数组，每个元素是一行，且每行都不能超过 `width`
- `handleInput?(data)`：组件获得焦点时接收键盘输入
- `invalidate?()`：清除缓存的渲染状态，下一次 `render()` 时从头计算

TUI 会在每一行末尾附加 SGR reset 和 OSC 8 reset，因此样式不会跨行自动延续。多行带样式文本需要逐行重设，或者使用 `wrapTextWithAnsi()`。

### Focusable Interface (IME Support)

需要显示文本光标并正确支持输入法候选框定位的组件，应实现 `Focusable`：

```typescript
import { CURSOR_MARKER, type Component, type Focusable } from "@earendil-works/pi-tui";

class MyInput implements Component, Focusable {
  focused: boolean = false;

  render(width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    return [`> ${beforeCursor}${marker}\x1b[7m${atCursor}\x1b[27m${afterCursor}`];
  }
}
```

当组件获得焦点时，TUI 会：

1. 设置 `focused = true`
2. 扫描输出中的 `CURSOR_MARKER`
3. 把硬件终端光标定位到对应位置
4. 在 `showHardwareCursor` 开启时显示真实光标

对于包含子 `Input`/`Editor` 的容器组件，需要把焦点状态继续传递给子组件，否则中文、日文、韩文输入法的候选框位置会错误。

## Built-in Components

### Container

基础容器，用于组合子组件。

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

### Box

带内边距和背景的容器。

```typescript
const box = new Box(
  1,
  1,
  (text) => chalk.bgGray(text)
);
box.addChild(new Text("Content"));
box.setBgFn((text) => chalk.bgBlue(text));
```

### Text

显示多行文本，支持自动换行和 padding。

```typescript
const text = new Text(
  "Hello World",
  1,
  1,
  (text) => chalk.bgGray(text)
);
text.setText("Updated text");
text.setCustomBgFn((text) => chalk.bgBlue(text));
```

### TruncatedText

单行文本组件，超出宽度时自动截断，适合 header、status line 等位置。

```typescript
const truncated = new TruncatedText(
  "This is a very long line that will be truncated...",
  0,
  0
);
```

### Input

单行输入框，支持水平滚动。

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```

常用按键：

- `Enter`：提交
- `Ctrl+A` / `Ctrl+E`：跳到行首/行尾
- `Ctrl+W` / `Alt+Backspace`：向后删词
- `Ctrl+U`：删到行首
- `Ctrl+K`：删到行尾
- `Ctrl+Left` / `Ctrl+Right`：按词移动
- `Alt+Left` / `Alt+Right`：按词移动
- 方向键、Backspace、Delete：常规编辑行为

### Editor

多行编辑器，支持自动补全、路径补全、大段粘贴处理，以及内容超出视口时的垂直滚动。

```typescript
interface EditorTheme {
  borderColor: (str: string) => string;
  selectList: SelectListTheme;
}

interface EditorOptions {
  paddingX?: number;
}

const editor = new Editor(tui, theme, options?);
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true;
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => chalk.blue(s);
editor.setPaddingX(1);
editor.getPaddingX();
```

能力摘要：

- 多行编辑和自动换行
- slash command 自动补全
- `Tab` 路径补全
- 大于 10 行的粘贴自动折叠成 `[paste #1 +50 lines]`
- 编辑器上下边框线
- 伪光标渲染

常用按键：

- `Enter`：提交
- `Shift+Enter` / `Ctrl+Enter` / `Alt+Enter`：换行
- `Tab`：自动补全
- `Ctrl+K`：删到行尾
- `Ctrl+U`：删到行首
- `Ctrl+W` / `Alt+Backspace`：向后删词
- `Alt+D` / `Alt+Delete`：向前删词
- `Ctrl+A` / `Ctrl+E`：跳到行首/行尾
- `Ctrl+]`：等待下一个字符并跳到其首次出现处
- `Ctrl+Alt+]`：反向跳转

### Markdown

Markdown 渲染组件，支持主题和可选语法高亮。

```typescript
interface MarkdownTheme {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
  highlightCode?: (code: string, lang?: string) => string[];
}

interface DefaultTextStyle {
  color?: (text: string) => string;
  bgColor?: (text: string) => string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

const md = new Markdown(
  "# Hello\n\nSome **bold** text",
  1,
  1,
  theme,
  defaultStyle
);
md.setText("Updated markdown");
```

### Loader

动画加载器。

```typescript
const loader = new Loader(
  tui,
  (s) => chalk.cyan(s),
  (s) => chalk.gray(s),
  "Loading..."
);
loader.start();
loader.setMessage("Still loading...");
loader.stop();
```

### CancellableLoader

带 `Escape` 取消能力的 `Loader`，同时暴露 `AbortSignal`。

```typescript
const loader = new CancellableLoader(
  tui,
  (s) => chalk.cyan(s),
  (s) => chalk.gray(s),
  "Working..."
);
loader.onAbort = () => done(null);
doAsyncWork(loader.signal).then(done);
```

属性：

- `signal: AbortSignal`
- `aborted: boolean`
- `onAbort?: () => void`

### SelectList

带键盘导航的选择列表。

```typescript
interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

const list = new SelectList(
  [
    { value: "opt1", label: "Option 1", description: "First option" },
    { value: "opt2", label: "Option 2", description: "Second option" },
  ],
  5,
  theme
);

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt");
```

控制方式：

- 方向键：移动
- `Enter`：选择
- `Escape`：取消

### SettingsList

设置面板，可循环切换值，或打开子菜单。

```typescript
interface SettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

interface SettingsListTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
}

const settings = new SettingsList(
  [
    { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
    { id: "model", label: "Model", currentValue: "gpt-4", submenu: (val, done) => modelSelector },
  ],
  10,
  theme,
  (id, newValue) => console.log(`${id} changed to ${newValue}`),
  () => console.log("Cancelled")
);
settings.updateValue("theme", "light");
```

控制方式：

- 方向键：移动
- `Enter` / `Space`：切换或进入子菜单
- `Escape`：取消

### Spacer

垂直空白组件。

```typescript
const spacer = new Spacer(2);
```

### Image

支持在 Kitty、Ghostty、WezTerm、iTerm2 等终端里内联渲染图片，不支持时回退为文本占位。

```typescript
interface ImageTheme {
  fallbackColor: (str: string) => string;
}

interface ImageOptions {
  maxWidthCells?: number;
  maxHeightCells?: number;
  filename?: string;
}

const image = new Image(
  base64Data,
  "image/png",
  theme,
  options
);
tui.addChild(image);
```

支持格式：PNG、JPEG、GIF、WebP。

## Autocomplete

### CombinedAutocompleteProvider

可同时处理 slash commands 和文件路径补全。

```typescript
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

const provider = new CombinedAutocompleteProvider(
  [
    { name: "help", description: "Show help" },
    { name: "clear", description: "Clear screen" },
    { name: "delete", description: "Delete last message" },
  ],
  process.cwd()
);

editor.setAutocompleteProvider(provider);
```

能力：

- 输入 `/` 触发命令补全
- 按 `Tab` 触发路径补全
- 支持 `~/`、`./`、`../`、`@` 前缀
- `@` 模式下只筛选可附加文件

## Key Detection

用 `matchesKey()` 和 `Key` 辅助器处理键盘事件：

```typescript
import { matchesKey, Key } from "@earendil-works/pi-tui";

if (matchesKey(data, Key.ctrl("c"))) {
  process.exit(0);
}

if (matchesKey(data, Key.enter)) {
  submit();
} else if (matchesKey(data, Key.escape)) {
  cancel();
} else if (matchesKey(data, Key.up)) {
  moveUp();
}
```

常见 key 标识：

- 基础键：`Key.enter`、`Key.escape`、`Key.tab`、`Key.space`、`Key.backspace`、`Key.delete`、`Key.home`、`Key.end`
- 方向键：`Key.up`、`Key.down`、`Key.left`、`Key.right`
- 带修饰键：`Key.ctrl("c")`、`Key.shift("tab")`、`Key.alt("left")`、`Key.ctrlShift("p")`

## Differential Rendering

框架使用三种渲染策略：

1. **首次渲染**：完整输出所有行，不清空 scrollback
2. **宽度变化或变更发生在视口上方**：清屏并全量重绘
3. **普通更新**：移动到首个变化行，清空到末尾，再只绘制变化部分

所有刷新都包在 synchronized output 控制序列中：

```text
\x1b[?2026h ... \x1b[?2026l
```

这样可以实现原子式、低闪烁刷新。

## Terminal Interface

任何实现了 `Terminal` 接口的对象都可作为底层终端：

```typescript
interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
}
```

内置实现：

- `ProcessTerminal`
- `VirtualTerminal`

## Utilities

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const width = visibleWidth("\x1b[31mHello\x1b[0m");
const truncated = truncateToWidth("Hello World", 8);
const truncatedNoEllipsis = truncateToWidth("Hello World", 8, "");
const lines = wrapTextWithAnsi("This is a long line that needs wrapping", 20);
```

用途：

- `visibleWidth()`：忽略 ANSI 码计算可见宽度
- `truncateToWidth()`：保留 ANSI 样式的前提下截断文本
- `wrapTextWithAnsi()`：保留 ANSI 样式地按宽度换行

## Creating Custom Components

自定义组件时最重要的一条规则：`render()` 返回的每一行都不能超过传入的 `width`。

### Handling Input

```typescript
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

class MyInteractiveComponent implements Component {
  private selectedIndex = 0;
  private items = ["Option 1", "Option 2", "Option 3"];

  public onSelect?: (index: number) => void;
  public onCancel?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.selectedIndex);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    return this.items.map((item, i) => {
      const prefix = i === this.selectedIndex ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
  }
}
```

### Handling Line Width

```typescript
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

class MyComponent implements Component {
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, width)];

    const line = this.text;
    const visible = visibleWidth(line);
    if (visible > width) {
      return [truncateToWidth(line, width)];
    }
    return [line + " ".repeat(width - visible)];
  }
}
```

### ANSI Code Considerations

`visibleWidth()` 与 `truncateToWidth()` 都会正确处理 ANSI 转义序列：

- `visibleWidth()` 计算宽度时忽略 ANSI 码
- `truncateToWidth()` 在截断时保留并正确闭合 ANSI 样式

```typescript
import chalk from "chalk";

const styled = chalk.red("Hello") + " " + chalk.blue("World");
const width = visibleWidth(styled);
const truncated = truncateToWidth(styled, 8);
```

### Caching

为了性能，组件通常应该缓存渲染结果，只在必要时重新计算：

```typescript
class CachedComponent implements Component {
  private text: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = [truncateToWidth(this.text, width)];

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

## Example

完整示例见 `test/chat-simple.ts`，其中包括：

- 带自定义背景色的 Markdown 消息
- 请求期间的加载动画
- 带补全和 slash commands 的编辑器
- 消息之间的垂直间距

运行方式：

```bash
npx tsx test/chat-simple.ts
```

## Development

```bash
npm install
npm run check
npx tsx test/chat-simple.ts
```

### Debug logging

设置 `PI_TUI_WRITE_LOG` 可把输出到 stdout 的原始 ANSI 流记录下来：

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log npx tsx test/chat-simple.ts
```
