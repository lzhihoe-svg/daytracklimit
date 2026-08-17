"""Inline the app into one self-contained HTML file (dist/tracker.html).

Handy for sharing the tracker as a single file — email it, drop it on a drive,
or publish it anywhere that serves one page.
"""
import os
import re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding='utf-8') as f:
        return f.read()


def main():
    html = read('index.html')
    css = read('assets', 'styles.css')
    data = read('data', 'orders.js')
    app = read('assets', 'app.js')

    html = html.replace(
        '<link rel="stylesheet" href="assets/styles.css">',
        '<style>\n' + css + '\n</style>')
    inlined = '<script>\n' + data + '\n</script>\n<script>\n' + app + '\n</script>'
    html = re.sub(
        r'<script src="data/orders\.js"></script>\s*<script src="assets/app\.js"></script>',
        lambda _: inlined,   # literal replacement: the scripts contain backslashes
        html)

    out_dir = os.path.join(ROOT, 'dist')
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, 'tracker.html')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    print('wrote', out, round(os.path.getsize(out) / 1024), 'KB')


if __name__ == '__main__':
    main()
