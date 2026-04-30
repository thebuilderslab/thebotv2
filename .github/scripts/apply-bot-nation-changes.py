#!/usr/bin/env python3
"""Apply bot-nation file changes from the build-change JSON on stdin.

Invoked by .github/workflows/deploy-agent.yml after curl fetches the
change payload from the Worker API. Writes each file under bot-nation/.
"""
import json
import os
import sys


def main() -> int:
    data = json.loads(sys.stdin.read())
    for f in data["files"]:
        raw = f["path"].replace("\\", "/").lstrip("./")
        if raw.startswith("bot-nation/"):
            raw = raw[len("bot-nation/"):]
        path = f"bot-nation/{raw}"
        parent = os.path.dirname(path) or "."
        os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(f["content"])
        print(f"  wrote: {path}")
    print(f"Applied {len(data['files'])} file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
