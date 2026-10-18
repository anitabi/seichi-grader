import os
import sys
import threading
import urllib.request
import webbrowser
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_START, PORT_END = 8126, 8136
TITLE_MARKERS = ('巡礼调色', '聖地巡礼')

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.html': 'text/html; charset=utf-8',
        '.json': 'application/json',
        '.wasm': 'application/wasm',
        '.onnx': 'application/octet-stream',
        '.svg': 'image/svg+xml',
        '.webmanifest': 'application/manifest+json',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def is_existing_server(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=0.8) as resp:
            if resp.status != 200:
                return False
            body = resp.read(16384).decode('utf-8', 'ignore')
            return any(marker in body for marker in TITLE_MARKERS)
    except Exception:
        return False


def open_browser(url):
    try:
        webbrowser.open(url)
    except Exception:
        try:
            os.startfile(url)
        except Exception:
            pass


def print_links(base):
    print('')
    print('可验收的页面：')
    print(f'  主界面          {base}')
    print(f'  回归自测        {base}selftest.html')
    print(f'  调色验收        {base}qa/grade-qa.html')
    print(f'  演示素材        {base}?qa-demo=1  （需要本地测试图）')
    print('')
    print('按 Ctrl+C 或直接关闭本窗口即可停止服务。')


def main():
    no_open = '--no-open' in sys.argv[1:]
    for port in range(PORT_START, PORT_END + 1):
        url = f'http://localhost:{port}/'
        if is_existing_server(port):
            print(f'本地服务已经在运行：{url}')
            if not no_open:
                open_browser(url)
            return 0
        try:
            server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        except OSError:
            continue

        print('聖地巡礼 · 调色对比生成器 - Windows 验收入口')
        print(f'目录：{ROOT}')
        print(f'地址：{url}')
        print_links(url)
        if not no_open:
            threading.Timer(0.8, open_browser, args=(url,)).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print('\n服务已停止。')
        finally:
            server.server_close()
        return 0

    print(f'端口 {PORT_START}-{PORT_END} 都被占用了，请先关闭其他本地服务后重试。')
    return 1


if __name__ == '__main__':
    sys.exit(main())
