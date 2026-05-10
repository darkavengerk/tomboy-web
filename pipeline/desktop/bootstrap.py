"""Interactive credential setup. Run once: ``python -m desktop.bootstrap``.

Walks the user through Dropbox OAuth (PKCE), extracts the account_id,
computes the Firebase uid, prompts for the Firebase service-account JSON
path, and writes ``config/pipeline.yaml``.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

import yaml


def sanitize_account_id(account_id: str) -> str:
    """Strip a leading ``dbid:`` prefix and replace anything that isn't
    ``[A-Za-z0-9_-]`` with ``-``. Mirrors the app's sanitization (see
    ``app/src/lib/firebase/app.ts``)."""
    if account_id.startswith("dbid:"):
        account_id = account_id[len("dbid:"):]
    return re.sub(r"[^A-Za-z0-9_-]", "-", account_id)


def compute_uid(account_id: str) -> str:
    return f"dbx-{sanitize_account_id(account_id)}"


def write_config(path: Path | str, data: dict[str, Any]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")


def _interactive_main(dry_run: bool) -> int:
    """Prompt the user step-by-step. Out of scope for unit tests — covered by manual verify."""
    print("Tomboy Diary Pipeline — bootstrap")
    print()

    # 1) Dropbox PKCE OAuth — point user at the URL, ask them to paste the code.
    # The PKCE flow is documented at https://developers.dropbox.com/oauth-guide.
    # We use the dropbox SDK's DropboxOAuth2FlowNoRedirect for this.
    import dropbox

    app_key = input("Dropbox app key (PUBLIC_DROPBOX_APP_KEY in app/.env): ").strip()
    flow = dropbox.DropboxOAuth2FlowNoRedirect(
        consumer_key=app_key,
        token_access_type="offline",
        use_pkce=True,
    )
    auth_url = flow.start()
    print()
    print(f"  → Open: {auth_url}")
    print("  → Paste the resulting code below.")
    code = input("Code: ").strip()
    res = flow.finish(code)
    refresh_token = res.refresh_token
    account_id = res.account_id
    uid = compute_uid(account_id)
    print(f"  ✓ Dropbox connected. uid = {uid}")

    # 2) Firebase service account
    sa_path = input("Path to Firebase service-account JSON: ").strip()
    if not Path(sa_path).expanduser().exists():
        print(f"  ✗ Service-account file not found: {sa_path}", file=sys.stderr)
        return 1

    # 3) rM + Pi connection details
    print()
    print("reMarkable connection:")
    rm_diary_notebook = input("  Diary notebook name on rM [Diary]: ").strip() or "Diary"
    rm_ssh_host = input("  rM SSH host [rm.local]: ").strip() or "rm.local"
    rm_ssh_user = input("  rM SSH user [root]: ").strip() or "root"

    print()
    print("Pi connection (the always-on inbox host):")
    pi_ssh_host = input("  Pi SSH host: ").strip()
    pi_ssh_port = int(input("  Pi SSH port [2222]: ").strip() or "2222")
    pi_ssh_user = input("  Pi SSH user [diary-sync]: ").strip() or "diary-sync"
    pi_ssh_key = input("  Pi SSH key [~/.ssh/id_ed25519_diary]: ").strip() or "~/.ssh/id_ed25519_diary"
    pi_inbox = input("  Pi inbox path [~/diary/inbox]: ").strip() or "~/diary/inbox"

    data = {
        "firebase_uid": uid,
        "firebase_service_account": str(Path(sa_path).expanduser()),
        "dropbox_refresh_token": refresh_token,
        "dropbox_app_key": app_key,
        "remarkable": {
            "diary_notebook_name": rm_diary_notebook,
            "ssh_host": rm_ssh_host,
            "ssh_user": rm_ssh_user,
        },
        "pi": {
            "ssh_host": pi_ssh_host,
            "ssh_port": pi_ssh_port,
            "ssh_user": pi_ssh_user,
            "ssh_key": pi_ssh_key,
            "inbox_path": pi_inbox,
        },
        "desktop": {"data_dir": "~/.local/share/tomboy-pipeline"},
        "tomboy": {
            "diary_notebook_name": "일기",
            "title_format": "{date} 리마커블([{page_uuid}])",
        },
        "ocr": {
            "backend": "local_vlm",
            "local_vlm": {
                "model_id": "Qwen/Qwen2.5-VL-7B-Instruct",
                "quantization": "4bit",
                "max_new_tokens": 2048,
                "system_prompt_path": "config/prompts/diary-ko.txt",
            },
        },
    }

    target = Path(__file__).resolve().parent.parent / "config" / "pipeline.yaml"
    if dry_run:
        print()
        print(f"--- Would write to {target} ---")
        print(yaml.safe_dump(data, allow_unicode=True, sort_keys=False))
        return 0
    if target.exists():
        ok = input(f"{target} exists. Overwrite? [y/N] ").strip().lower()
        if ok != "y":
            print("Aborted.")
            return 1
    write_config(target, data)
    print(f"  ✓ Wrote {target}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    return _interactive_main(args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
