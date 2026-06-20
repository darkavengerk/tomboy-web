import json
import textwrap
from pathlib import Path

from desktop.trigger_server import ConfigStore

_BASE_YAML = textwrap.dedent("""\
    firebase_uid: "dbx-x"
    firebase_service_account: "/tmp/sa.json"
    remarkable: { diary_notebook_name: "Diary", ssh_host: "rm", ssh_user: "root" }
    pi: { ssh_host: "pi", ssh_port: 2222, ssh_user: "u", ssh_key: "~/.ssh/k", inbox_path: "~/in" }
    ocr:
      backend: "claude"
      claude: { service_url: "http://x", service_token: "t", effort: "high", system_prompt_path: "config/prompts/diary-ko.txt" }
""")


def _store(tmp_path: Path) -> ConfigStore:
    root = tmp_path
    (root / "config").mkdir()
    (root / "config" / "pipeline.yaml").write_text(_BASE_YAML, encoding="utf-8")
    (root / "config" / "prompts").mkdir()
    (root / "config" / "prompts" / "diary-ko.txt").write_text("파일 기본 프롬프트", encoding="utf-8")
    return ConfigStore(
        pipeline_yaml=root / "config" / "pipeline.yaml",
        folders_yaml=root / "config" / "folders.yaml",
        root=root,
    )


def test_read_effective_falls_back_to_prompt_file(tmp_path):
    store = _store(tmp_path)
    cfg = store.read_effective()
    assert cfg["defaultPrompt"] == "파일 기본 프롬프트"
    names = {f["name"] for f in cfg["folders"]}
    assert {"Diary", "Notes", "Slip-Notes"} <= names


def test_write_then_read_roundtrip_and_pipeline_untouched(tmp_path):
    store = _store(tmp_path)
    before = (tmp_path / "config" / "pipeline.yaml").read_text(encoding="utf-8")
    payload = {
        "defaultPrompt": "새 기본",
        "folders": [
            {"name": "Diary", "notebook": "일기", "titleFormat": "{date} 리마커블([{unit_key}])",
             "split": False, "labels": [], "prompt": "다이어리 프롬프트"},
        ],
    }
    assert store.validate(payload) is None
    store.write(payload)
    assert (tmp_path / "config" / "folders.yaml").exists()
    after = (tmp_path / "config" / "pipeline.yaml").read_text(encoding="utf-8")
    assert before == after
    cfg = store.read_effective()
    assert cfg["defaultPrompt"] == "새 기본"
    diary = next(f for f in cfg["folders"] if f["name"] == "Diary")
    assert diary["prompt"] == "다이어리 프롬프트"


def test_validate_rejects_bad_placeholder(tmp_path):
    store = _store(tmp_path)
    err = store.validate({"defaultPrompt": "", "folders": [
        {"name": "X", "notebook": "n", "titleFormat": "{date} {bogus}", "split": False, "labels": [], "prompt": ""}
    ]})
    assert err is not None and "bogus" in err


def test_validate_rejects_wrong_types(tmp_path):
    store = _store(tmp_path)
    assert store.validate({"folders": "nope"}) is not None
    assert store.validate({"folders": [{"name": "", "titleFormat": "{date}"}]}) is not None


def test_http_get_put_config(tmp_path):
    from io import BytesIO
    from desktop.trigger_server import JobState, PipelineRunner, make_handler

    store = _store(tmp_path)
    handler_cls = make_handler(
        token="tok", state=JobState(),
        runner=PipelineRunner(cwd=tmp_path, python="python"),
        config_store=store,
    )

    class FakeHandler(handler_cls):  # type: ignore[misc, valid-type]
        def __init__(self, method, path, body=b"", token="tok"):
            self.command = method
            self.path = path
            self.headers = {"Authorization": f"Bearer {token}", "Content-Length": str(len(body))}
            self.rfile = BytesIO(body)
            self.wfile = BytesIO()
            self._status = None
            self._headers_sent = {}
        def send_response(self, code, *a): self._status = code
        def send_header(self, k, v): self._headers_sent[k] = v
        def end_headers(self): pass
        def log_message(self, *a, **k): pass

    h = FakeHandler("GET", "/config")
    h.do_GET()
    assert h._status == 200
    out = json.loads(h.wfile.getvalue().decode("utf-8"))
    assert out["ok"] and "folders" in out

    body = json.dumps({"defaultPrompt": "p", "folders": [
        {"name": "Diary", "notebook": "일기", "titleFormat": "{date}", "split": False, "labels": [], "prompt": ""}
    ]}).encode("utf-8")
    h = FakeHandler("PUT", "/config", body)
    h.do_PUT()
    assert h._status == 200

    h = FakeHandler("PUT", "/config", body, token="WRONG")
    h.do_PUT()
    assert h._status == 401


def test_validate_rejects_attribute_index_positional_placeholders(tmp_path):
    store = _store(tmp_path)
    def err_for(tf):
        return store.validate({"defaultPrompt": "", "folders": [
            {"name": "X", "notebook": "n", "titleFormat": tf, "split": False, "labels": [], "prompt": ""}
        ]})
    assert err_for("{date.__class__}") is not None
    assert err_for("{date[0]}") is not None
    assert err_for("{}") is not None
    assert err_for("{date!r}") is not None
    # plain placeholders and :format-spec remain allowed
    assert err_for("{date} {unit_key}") is None
    assert err_for("{datetime:>5}") is None
