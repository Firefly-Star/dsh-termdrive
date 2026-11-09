"""自检用的被驱动程序：报出自己的 TTY 状态，然后等一行输入。

- readline 而不是 read(1)：tmux 的 pty 默认是规范模式，readline 才会在回车时返回。
- flush=True：否则输出会在缓冲里，tmux 屏幕上什么也看不到。
"""
import os
import sys

print("isatty(stdin) =", os.isatty(0), flush=True)
print("READY", flush=True)

line = sys.stdin.readline()

print("received:", repr(line), flush=True)
print("DONE", flush=True)
