# automation-service deploy (desktop only)

브릿지(`/automation/run`)가 호출하는 데스크탑 서비스. 등록된 명령을 호스트에서
`spawn`으로 실행하고 `{results:{project:csv}, errors:{project:msg}}`를 반환한다.

## 빌드
    cd automation-service
    npm install
    npm run build   # → dist/server.js

## 환경파일 `~/.config/automation-service.env`
    BRIDGE_SHARED_TOKEN=<브릿지 BRIDGE_SECRET과 동일>
    AUTOMATION_SERVICE_PORT=7843
    AUTOMATION_CONFIG=/home/<you>/.config/tomboy-automation.json
    AUTOMATION_TIMEOUT_MS=30000
    AUTOMATION_MAX_OUTPUT_BYTES=5242880

> **주의:** EnvironmentFile의 값은 리터럴로 읽힌다. `%h`(systemd 지시자)도 `$HOME`도 **확장되지 않는다**.
> `AUTOMATION_CONFIG`를 생략하면 서버가 `process.env.HOME`을 이용해 `~/.config/tomboy-automation.json`을 기본값으로 사용한다.

## registry `~/.config/tomboy-automation.json`
    {
      "commands": {
        "loc-history": [
          { "project": "tomboy",
            "exec": ["python3", "/home/<you>/loc-history.py",
                     "/var/home/<you>/workspace/tomboy-web", "--csv-only", "--exclude", "graphify-out/"] }
        ]
      }
    }
`exec`는 셸을 거치지 않고 인자 배열로 실행된다. 경로/인자는 여기에만 존재(노트는 command id만 전달).

## 설치
    cp deploy/automation-service.service ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now automation-service
    loginctl enable-linger $USER

## 브릿지 연결
브릿지의 `~/.config/term-bridge.env`에:
    AUTOMATION_SERVICE_URL=http://<desktop-LAN-IP>:7843
