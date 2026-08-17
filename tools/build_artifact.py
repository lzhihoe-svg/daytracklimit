"""Build the page-body-only variant used for publishing as a hosted Artifact.

The Artifact host supplies its own <!doctype>/<head>/<body> skeleton, so this
strips ours and inlines the stylesheet, data and script.
"""
import os
import re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding='utf-8') as f:
        return f.read()


def main():
    html = read('index.html')
    body = re.search(r'<body>(.*)</body>', html, re.S).group(1)
    body = re.sub(r'<script src="[^"]+"></script>', '', body)

    parts = [
        '<title>Aramega Load Board</title>',
        '<style>\n' + read('assets', 'styles.css') + '\n</style>',
        body.strip(),
        '<script>\n' + read('data', 'orders.js') + '\n</script>',
        '<script>\n' + read('assets', 'app.js') + '\n</script>',
    ]

    out_dir = os.path.join(ROOT, 'dist')
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, 'artifact.html')
    with open(out, 'w', encoding='utf-8') as f:
        f.write('\n\n'.join(parts) + '\n')
    print('wrote', out, round(os.path.getsize(out) / 1024), 'KB')


if __name__ == '__main__':
    main()
