"""
Windows service host for the Simple Pilot Logbook agent.

Runs agent/main.py's run() loop as the "SimplePilotLogbook" Windows service so
flights are captured and uploaded to the Cloudflare Worker whenever Windows is
running. Install/remove with install_service.ps1 / uninstall_service.ps1.
"""

from __future__ import annotations

import sys
import threading
import traceback
from datetime import datetime
from pathlib import Path

import servicemanager
import win32event
import win32service
import win32serviceutil


AGENT_DIR = Path(__file__).resolve().parent
SERVICE_LOG_PATH = AGENT_DIR / "service.log"

if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))


def log_service_message(message: str) -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with SERVICE_LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"[{timestamp}] {message}\n")


class SimplePilotLogbookService(win32serviceutil.ServiceFramework):
    _svc_name_ = "SimplePilotLogbook"
    _svc_display_name_ = "Simple Pilot Logbook"
    _svc_description_ = (
        "Detects MSFS flights via SimConnect and uploads them to the "
        "Simple Pilot Logbook Cloudflare Worker."
    )

    def __init__(self, args):
        super().__init__(args)
        self.win32_stop_event = win32event.CreateEvent(None, 0, 0, None)
        self.agent_stop_event = threading.Event()
        self.agent_thread: threading.Thread | None = None

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        servicemanager.LogInfoMsg("Stopping Simple Pilot Logbook service.")
        log_service_message("Stopping service.")
        self.agent_stop_event.set()
        win32event.SetEvent(self.win32_stop_event)

    def SvcDoRun(self):
        servicemanager.LogInfoMsg("Starting Simple Pilot Logbook service.")
        log_service_message("Starting service.")
        self.main()

    def main(self):
        try:
            import main as agent_main  # agent/main.py

            self.agent_thread = threading.Thread(
                target=self._run_agent, args=(agent_main,), name="agent-main", daemon=True
            )
            self.agent_thread.start()
            log_service_message("Agent thread started.")

            while True:
                wait_result = win32event.WaitForSingleObject(self.win32_stop_event, 1000)
                if wait_result == win32event.WAIT_OBJECT_0:
                    break
                if not self.agent_thread.is_alive():
                    raise RuntimeError(
                        "Agent thread exited unexpectedly. "
                        f"See {SERVICE_LOG_PATH} and agent.log for details."
                    )

            while self.agent_thread.is_alive():
                self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING, waitHint=5000)
                self.agent_thread.join(timeout=1)

            log_service_message("Agent thread stopped gracefully.")
        except Exception:
            details = traceback.format_exc()
            log_service_message("Service failed:\n" + details)
            servicemanager.LogErrorMsg(details)
            raise

    def _run_agent(self, agent_main) -> None:
        try:
            agent_main.run(self.agent_stop_event)
        except SystemExit as exc:  # load_config() reports missing settings this way
            log_service_message(f"Agent exited: {exc}")
        except Exception:
            log_service_message("Agent crashed:\n" + traceback.format_exc())


if __name__ == "__main__":
    win32serviceutil.HandleCommandLine(SimplePilotLogbookService)
