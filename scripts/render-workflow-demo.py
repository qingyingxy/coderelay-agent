"""Rasterize captured terminal cells. Requires Pillow; no UI text is reconstructed."""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
CAPTURE = ROOT / ".artifacts/github-demo-recording"
scenario = sys.argv[1] if len(sys.argv) > 1 else "config"
if scenario not in ("config", "automatic", "planner"):
    raise ValueError("Use config, automatic or planner")
prefix = "interactive" if scenario == "config" else scenario
data = json.loads((CAPTURE / f"{prefix}-frames.json").read_text(encoding="utf-8"))
font_dir = Path("C:/Windows/Fonts")
regular = ImageFont.truetype(str(font_dir / "consola.ttf") if font_dir.exists() else "DejaVuSansMono.ttf", 20)
bold = ImageFont.truetype(str(font_dir / "consolab.ttf") if font_dir.exists() else "DejaVuSansMono-Bold.ttf", 20)
symbols = ImageFont.truetype(str(font_dir / "seguisym.ttf") if font_dir.exists() else "DejaVuSans.ttf", 20)
cjk = ImageFont.truetype(str(font_dir / "msyh.ttc") if font_dir.exists() else "NotoSansCJK-Regular.ttc", 20)
palette = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
]
for r in [0, 95, 135, 175, 215, 255]:
    for g in [0, 95, 135, 175, 215, 255]:
        for b in [0, 95, 135, 175, 215, 255]:
            palette.append(f"#{r:02x}{g:02x}{b:02x}")
palette.extend(f"#{v:02x}{v:02x}{v:02x}" for v in range(8, 239, 10))


def color(spec, default):
    if spec is None:
        return default
    return f"#{spec[1]:06x}" if spec[0] == "rgb" else palette[spec[1]]


texts = ["\n".join("".join(c[1] or " " for c in line) for line in frame["lines"]) for frame in data["frames"]]
stages = [
    ("01 明确需求：配置读取、默认值、错误提示", 3000,
     lambda text: "3. 格式错误时给出明确提示" in text and "write" not in text),
    ("02 测试发现问题：缺失文件没有使用默认值", 3000,
     lambda text: "测试结果：2/3" in text and "new_context" not in text and "Started fresh" not in text and "历史记录 · 本页" not in text),
    ("03 切换上下文：保留待办，旧测试输出已移出", 4000,
     lambda text: "Started fresh" in text and "重跑三项测试。" in text and "历史记录 · 本页" not in text),
    ("04 按需查证：交接缺少细节，找回失败用例", 2000,
     lambda text: "历史记录 · 本页" in text and "现在补上这个分支。" in text and "edit src/config" not in text),
    ("05 继续修复：补上缺失配置文件的处理", 2000,
     lambda text: "edit src/config" in text and "if (!existsSync(path))" in text and "测试结果：3/3" not in text),
    ("06 验证完成：三项测试全部通过", 4000,
     lambda text: "测试结果：3/3" in text and "三项测试全部通过。" in text and "Completed" in text),
]
if scenario == "automatic":
    stages = [
        ("01 开始任务：配置读取与默认值", 2500,
         lambda text: "3. 格式错误时给出明确提示" in text and "write" not in text),
        ("02 实现进行中：读取大文件，达到上下文阈值", 2500,
         lambda text: "触发真实上下文阈值" in text and "Started fresh" not in text),
        ("03 自动切窗：保留目标，继续读取已有代码", 4000,
         lambda text: "Started fresh" in text and "不重新开始" in text and "edit src/config" not in text),
        ("04 接着完成：补齐默认值分支", 2500,
         lambda text: "edit src/config" in text and "if (!existsSync(path))" in text and "测试结果：3/3" not in text),
        ("05 完成任务：三项测试一次通过", 3500,
         lambda text: "测试结果：3/3" in text and "Completed" in text),
    ]
elif scenario == "planner":
    stages = [
        ("01 规划代理：给出计划，等待批准", 4000,
         lambda text: "规划代理 · 计划待批准" in text and "操作：/approve" in text),
        ("02 执行代理：接收范围，按计划实现", 4000,
         lambda text: "执行代理 · 正在执行" in text and "任务 0/1" in text),
        ("03 执行代理已交付：返回修改结果，执行验收通过", 4000,
         lambda text: "执行代理 · 已交付" in text and "修改：src/config.mjs" in text and "项检查通过" in text),
    ]
height = 90 + data["rows"] * 22 + 22
frames = []
selected = []
previous = -1
for title, duration, predicate in stages:
    matches = [i for i, text in enumerate(texts) if i > previous and predicate("".join(line.strip() for line in text.splitlines()))]
    if not matches:
        raise RuntimeError(f"No verified terminal frame for stage: {title}; previous={previous}")
    index = matches[0]
    for candidate in matches[1:]:
        if candidate != index + 1:
            break
        index = candidate
    previous = index
    frame = data["frames"][index]
    selected.append({"title": title, "sourceTimeMs": frame["time"], "durationMs": duration})
    im = Image.new("RGB", (1240, height), "#10141c")
    draw = ImageDraw.Draw(im)
    draw.rectangle((0, 0, 1239, 79), fill="#1c2330")
    draw.text((20, 8), title, font=cjk, fill="#e5e5e5")
    disclosure = {
        "config": "关键画面节选 · 离线预设模型 · 文件修改与测试真实执行",
        "automatic": "离线预设模型 · 64k 演示窗口 / 大文件触发阈值 · 非真实模型速度",
        "planner": "真实 CLI 界面节选 · 预设模型 / 自动输入命令 · RPC 与文件验收真实执行",
    }[scenario]
    draw.text((20, 42), disclosure, font=cjk, fill="#a9bacd")
    for y, line in enumerate(frame["lines"]):
        for x, chars, width, fg, bg, is_bold, dim, inverse in line:
            foreground = color(fg, "#e5e5e5")
            background = color(bg, "#10141c")
            if inverse:
                foreground, background = background, foreground
            if dim:
                a, b = bytes.fromhex(foreground[1:]), bytes.fromhex(background[1:])
                foreground = "#" + "".join(f"{(v + w) // 2:02x}" for v, w in zip(a, b))
            px, py = 20 + x * 12, 90 + y * 22
            draw.rectangle((px, py, px + width * 12 - 1, py + 21), fill=background)
            if chars:
                font = symbols if any(ord(char) > 127 for char in chars) else bold if is_bold else regular
                if any("\u2e80" <= char <= "\uffef" for char in chars):
                    font = cjk
                # Share a baseline across Latin, CJK and fallback symbol fonts.
                draw.text((px, py + 17), chars, font=font, fill=foreground, anchor="ls")
    frames.append(im)
durations = [stage[1] for stage in stages]
out = ROOT / "docs/images"
asset = {"config": "coderelay-config-demo", "automatic": "coderelay-auto-context-demo", "planner": "coderelay-planner-executor-demo"}[scenario]
frames[0].save(out / f"{asset}.gif", save_all=True, append_images=frames[1:],
               duration=durations, loop=0, optimize=True)
frames[2].save(out / f"{asset}.png")
sheet = Image.new("RGB", (1240, ((len(frames) + 1) // 2) * (height // 2)), "#10141c")
for n, frame in enumerate(frames):
    sheet.paste(frame.resize((620, height // 2)), ((n % 2) * 620, (n // 2) * (height // 2)))
sheet.save(CAPTURE / f"{prefix}-contact-sheet.png")
(CAPTURE / f"{prefix}-manifest.json").write_text(json.dumps({
    "source": "Actual InteractiveMode stdout",
    "capture": "xterm/headless; no desktop capture; captions and hold times added",
    "scenario": scenario, "model": "offline faux provider", "frameCount": len(frames),
    "durationMs": sum(durations), "size": [1240, height], "stages": selected,
}, indent=2), encoding="utf-8")
print(f"Rendered {len(frames)} frames, {sum(durations) / 1000:.1f}s")
