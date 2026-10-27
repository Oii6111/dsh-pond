"""看图工具里那几个纯函数的回归检查（不联网）。

跑法（用插件自己的 venv，里面已经有 mcp / bilibili_api / Pillow）：
    <家目录>/.venv/Scripts/python.exe tools/check-vision.py

钉住两件踩过的事：
  · B 站给的封面地址是 http:// 时必须升成 https（否则带着登录凭据走明文）
  · 故事板 index 的秒 / 毫秒两种单位都要归一正确
    （2026-10-23 踩过：6 小时视频的秒数被当成毫秒，三帧塌成同一张）
"""

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vendor" / "bilibili-mcp"))

try:                        # Windows 控制台默认 GBK，输出中文/符号会炸
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import mcp_server as S  # noqa: E402

fail = []


def check(name, got, want):
    if got != want:
        fail.append(f"{name}: got {got!r} want {want!r}")


# ── _https / _cover_url ──────────────────────────────────────
check("_https http", S._https("http://i0.hdslb.com/a.jpg"), "https://i0.hdslb.com/a.jpg")
check("_https 协议相对", S._https("//i0.hdslb.com/b.jpg"), "https://i0.hdslb.com/b.jpg")
check("_https 已是 https", S._https("https://i0.hdslb.com/c.jpg"), "https://i0.hdslb.com/c.jpg")
check("_https 空", S._https(""), "")
check("_cover_url 砍掉原有 @ 参数",
      S._cover_url("http://i0.hdslb.com/d.jpg@1c.png"),
      "https://i0.hdslb.com/d.jpg@512w.jpg")

# ── _snapshot_entries ───────────────────────────────────────
sec = {"index": [0, 0, 5, 10, 5538, 22163]}
check("秒不除 1000", [t for t, _ in S._snapshot_entries(sec, 22164.0)],
      [0.0, 0.0, 5.0, 10.0, 5538.0, 22163.0])
check("块序号就是数组下标", [i for _, i in S._snapshot_entries(sec, 22164.0)], list(range(6)))

ms = {"index": [0, 5000, 22163000]}
check("毫秒要除 1000", [t for t, _ in S._snapshot_entries(ms, 22164.0)], [0.0, 5.0, 22163.0])

check("duration=0 不做猜测",
      [t for t, _ in S._snapshot_entries({"index": [0, 22163]}, 0)], [0.0, 22163.0])
check("{timestamp} 对象形状",
      [t for t, _ in S._snapshot_entries({"index": [{"timestamp": 0}, {"timestamp": 5}]}, 100.0)],
      [0.0, 5.0])
check("空 index", S._snapshot_entries({}, 100.0), [])

# ── _image_headers：图床请求绝不能带 Cookie ──────────────────
h = S._image_headers()
check("图床头只有 UA + Referer", sorted(k.lower() for k in h), ["referer", "user-agent"])

# ── _crop_tile：2×1 拼图，取第 1 块应该是右半边 ─────────────
import io  # noqa: E402

from PIL import Image  # noqa: E402

sheet = Image.new("RGB", (960, 270), (255, 0, 0))
sheet.paste(Image.new("RGB", (480, 270), (0, 0, 255)), (480, 0))
buf = io.BytesIO()
sheet.save(buf, format="PNG")
tile = S._crop_tile(buf.getvalue(), 1, 480, 270)
img = Image.open(io.BytesIO(tile)).convert("RGB")
check("裁出来的尺寸", img.size, (480, 270))
r, _g, b = img.getpixel((240, 135))
check("取的是右半边（蓝色）", (r < 40 and b > 200), True)   # JPEG 有损，别比精确值

if fail:
    print("❌ 失败：")
    for f in fail:
        print("  " + f)
    sys.exit(1)

print("✓ 看图工具纯函数检查全部通过")
