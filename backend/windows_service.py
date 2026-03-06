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
from pathlib import Path

import servicemanager
import uvicorn
import win32event
import win32service
import win32serviceutil


ROOT_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = Path(__file__).resolve().parent

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from main import app  # noqa: E402


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
        socket.setdefaulttimeout(60)

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        servicemanager.LogInfoMsg("Stopping Simple Pilot Logbook service.")
        if self.server is not None:
            self.server.should_exit = True
        win32event.SetEvent(self.stop_event)

    def SvcDoRun(self):
        servicemanager.LogInfoMsg("Starting Simple Pilot Logbook service.")
        self.main()

    def main(self):
        os.chdir(ROOT_DIR)
        config = uvicorn.Config(
            app=app,
            host="0.0.0.0",
            port=8080,
            log_level="info",
        )
        self.server = uvicorn.Server(config)

        server_thread = threading.Thread(target=self.server.run, daemon=True)
        server_thread.start()

        win32event.WaitForSingleObject(self.stop_event, win32event.INFINITE)
        server_thread.join(timeout=30)


if __name__ == "__main__":
    win32serviceutil.HandleCommandLine(SimplePilotLogbookService)
