from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Thread


def check_page(binary, url, engine):
    result = subprocess.run(
        [binary, "fetch", url], capture_output=True, text=True, timeout=30
    )
    if result.returncode:
        raise SystemExit(f"{engine}: scrim exited with {result.returncode}\n{result.stderr}")
    expected = ("visible body text", f"{engine} inserted text")
    if any(text not in result.stdout for text in expected) or "hidden sentinel" in result.stdout:
        raise SystemExit(f"{engine}: unexpected page text\n{result.stdout}")


def check_eval(binary, url, engine):
    failure = subprocess.run(
        [binary, "fetch", url, "--eval", 'throw new Error("eval smoke failure")'],
        capture_output=True, text=True, timeout=30,
    )
    if failure.returncode != 1 or failure.stdout or "eval smoke failure" not in failure.stderr:
        raise SystemExit(f"{engine}: unexpected eval failure result: {failure}")

    success = subprocess.run(
        [binary, "fetch", url, "--eval", '"ERR:valid result"'],
        capture_output=True, text=True, timeout=30, check=True,
    )
    if not success.stdout.startswith("ERR:valid result\n") or "visible body text" not in success.stdout:
        raise SystemExit(f"{engine}: unexpected eval success result: {success}")


def check_session(binary, url, session):
    command = [binary, "--session", str(session)]
    subprocess.run([*command, "goto", url], capture_output=True, timeout=30, check=True)
    result = subprocess.run(
        [*command, "eval", 'document.body.append("session marker"); throw new Error("session error")'],
        capture_output=True, text=True, timeout=30, check=True,
    )
    if result.stdout.strip() != "ERR:session error":
        raise SystemExit(f"unexpected session eval result: {result}")

    page = subprocess.run(
        [*command, "text"], capture_output=True, text=True, timeout=30, check=True,
    )
    if "session marker" not in page.stdout:
        raise SystemExit(f"session did not replay the DOM edit: {page}")


def main(binary):
    with TemporaryDirectory() as directory:
        # Exceed scrim's 256 KiB threshold so the second page uses V8.
        v8_padding = "/*" + " " * (256 * 1024) + "*/"
        for engine, padding in (("QuickJS", ""), ("V8", v8_padding)):
            Path(directory, f"{engine}.html").write_text(
                "<!doctype html><p>visible body text</p>"
                '<p style="display:none">hidden sentinel inline</p>'
                "<style>.gone{display:none}</style><p class=gone>hidden sentinel stylesheet</p>"
                f"<script>{padding}\n"
                f"document.body.insertAdjacentHTML('beforeend', '<p>{engine} inserted text</p>');"
                "</script>",
                encoding="utf-8",
            )
        handler = partial(SimpleHTTPRequestHandler, directory=directory)
        with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for engine in ("QuickJS", "V8"):
                    url = f"http://127.0.0.1:{server.server_port}/{engine}.html"
                    check_page(binary, url, engine)
                    check_eval(binary, url, engine)
                    check_session(binary, url, Path(directory, f"{engine}-session"))
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    main(sys.argv[1])
