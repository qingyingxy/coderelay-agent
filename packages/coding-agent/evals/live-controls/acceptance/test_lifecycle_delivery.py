"""Shared next-round acceptance; imports only the selected workspace's business code."""

import queue
import threading
import unittest
from unittest.mock import Mock, patch

from ballfight_live_bridge.controller import LiveSourceController
from ballfight_live_bridge.dashboard_runtime import DashboardRuntime
from ballfight_live_bridge.models import GiftPriorityCandidate, RegistrationCandidate
from ballfight_live_bridge.router import BridgeUnavailable, RegistrationRouter


class LifecycleDeliveryTests(unittest.TestCase):
    def test_failed_resume_after_open_does_not_consume_gift(self):
        bridge = Mock()
        bridge.live_state.side_effect = [
            {"sessionClosed": False, "registrationOpen": True},
            {"sessionClosed": True},
        ]
        bridge.set_live_session.side_effect = BridgeUnavailable("offline test")
        router = RegistrationRouter(lambda *_: None, bridge)
        router._refresh_state()
        self.assertTrue(router.submit_gift(GiftPriorityCandidate(
            viewer_name="Probe", viewer_id="probe", source="kuaishou-websocket",
            event_id="probe-gift", occurred_at=0, gift_id=1, gift_name="Probe",
            count=1, gift_unit_price=1,
        )))

        def finish_iteration(*_args, **_kwargs):
            router.stop()
            raise queue.Empty

        with patch.object(router.candidates, "get", side_effect=finish_iteration):
            router._run()
        bridge.post_gift_priority.assert_not_called()
        self.assertEqual(router.gifts.qsize(), 1)

    def test_end_rejects_stale_state_and_queued_registration(self):
        entered, release, ended = threading.Event(), threading.Event(), threading.Event()
        bridge = Mock()
        stale = {"sessionClosed": False, "registrationOpen": True,
                 "pendingGiftTickets": 7, "giftQueue": [{"viewerName": "Probe", "availableTickets": 7}]}

        def delayed_state():
            entered.set()
            if not release.wait(5):
                raise RuntimeError("state barrier timed out")
            return stale.copy()

        bridge.live_state.side_effect = delayed_state
        bridge.post_registration.return_value = "probe-registration"
        with patch("ballfight_live_bridge.dashboard_runtime.load_config", return_value={}):
            runtime = DashboardRuntime()
        router = RegistrationRouter(runtime.handle_event, bridge)
        # Avoid live collectors while retaining the actual controller stop implementation.
        controller = LiveSourceController.__new__(LiveSourceController)
        for name in ("stop_event", "log_stop_event", "web_stop_event", "xiaohongshu_stop_event"):
            setattr(controller, name, threading.Event())
        controller.ocr_worker = None
        controller.router = router
        controller.thread = None
        runtime.controller = controller
        router.submit(RegistrationCandidate(viewer_name="Probe", source="kuaishou-websocket", confidence=1.0))
        errors = []

        def route():
            try:
                router._run()
            except BaseException as exc:
                errors.append(exc)

        def end_session():
            try:
                runtime.execute({"action": "end-live-session"})
            except BaseException as exc:
                errors.append(exc)
            finally:
                ended.set()

        worker = threading.Thread(target=route, daemon=True)
        router.thread = worker
        controller.thread = worker
        ender = threading.Thread(target=end_session, daemon=True)
        worker.start()
        try:
            self.assertTrue(entered.wait(5))
            with patch("ballfight_live_bridge.dashboard_runtime.UnityBridgeClient", return_value=bridge):
                ender.start()
                self.assertTrue(router.stop_event.wait(5))
                # Permit both implementations: stop may wait for in-flight work or invalidate it.
                ended.wait(0.2)
                release.set()
                ender.join(5)
                worker.join(5)
        finally:
            release.set()
            router.stop_event.set()
            worker.join(5)
            if ender.ident is not None:
                ender.join(5)
        self.assertFalse(worker.is_alive())
        self.assertFalse(ender.is_alive())
        self.assertEqual(errors, [])
        runtime.handle_event("stopped", None)
        self.assertTrue(runtime.unity["sessionClosed"])
        self.assertFalse(runtime.unity["registrationOpen"])
        self.assertEqual(runtime.unity.get("pendingGiftTickets", 0), 0)
        self.assertEqual(runtime.unity["giftQueue"], [])
        bridge.post_registration.assert_not_called()


if __name__ == "__main__":
    unittest.main()
