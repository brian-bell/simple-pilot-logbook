"""
Windows service host for Simple Pilot Logbook.

Installs and runs the existing FastAPI application as a Windows service so the
logbook server starts automatically when Windows boots.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import traceback
from datetime import datetime
from pathlib import Path

import servicemanager
import uvicorn
import win32event
import win32service
import win32serviceutil


ROOT_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = Path(__file__).resolve().parent
SERVICE_LOG_PATH = BACKEND_DIR / "service.log"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


def log_service_message(message: str) -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with SERVICE_LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"[{timestamp}] {message}\n")


def load_app():
    from main import app

    return app


class SimplePilotLogbookService(win32serviceutil.ServiceFramework):
    _svc_name_ = "SimplePilotLogbook"
    _svc_display_name_ = "Simple Pilot Logbook"
    _svc_description_ = (
        "Runs the Simple Pilot Logbook web server and SimConnect worker at startup."
    )

    def __init__(self, args):
        super().__init__(args)
        self.stop_event = win32event.CreateEvent(None, 0, 0, None)
        self.server: uvicorn.Server | None = None
        self.server_thread: threading.Thread | None = None
        socket.setdefaulttimeout(60)

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        servicemanager.LogInfoMsg("Stopping Simple Pilot Logbook service.")
        log_service_message("Stopping service.")
        if self.server is not None:
            self.server.should_exit = True
        win32event.SetEvent(self.stop_event)

    def SvcDoRun(self):
        servicemanager.LogInfoMsg("Starting Simple Pilot Logbook service.")
        log_service_message("Starting service.")
        self.main()

    def main(self):
        try:
            os.chdir(ROOT_DIR)
            app = load_app()
            config = uvicorn.Config(
                app=app,
                host="127.0.0.1",
                port=8080,
                log_level="info",
                use_colors=False,
            )
            self.server = uvicorn.Server(config)

            self.server_thread = threading.Thread(target=self.server.run)
            self.server_thread.start()
            log_service_message("Uvicorn server thread started.")

            while True:
                wait_result = win32event.WaitForSingleObject(self.stop_event, 1000)
                if wait_result == win32event.WAIT_OBJECT_0:
                    break
                if not self.server_thread.is_alive():
                    raise RuntimeError(
                        "Uvicorn server thread exited unexpectedly during service startup. "
                        f"See {SERVICE_LOG_PATH} for details."
                    )

            while self.server_thread.is_alive():
                self.ReportServiceStatus(
                    win32service.SERVICE_STOP_PENDING,
                    waitHint=5000,
                )
                self.server_thread.join(timeout=1)

            log_service_message("Uvicorn server thread stopped gracefully.")
        except Exception:
            details = traceback.format_exc()
            log_service_message("Service startup failed:\n" + details)
            servicemanager.LogErrorMsg(details)
            raise


if __name__ == "__main__":
    win32serviceutil.HandleCommandLine(SimplePilotLogbookService)
