import json
import threading
import unittest
from urllib.request import Request, urlopen
from unittest.mock import patch

from ballfight_live_bridge.dashboard_runtime import DashboardRuntime
from dashboard_server import DashboardServer


class PaginationContract(unittest.TestCase):
    def setUp(self):
        self.config_patch = patch('ballfight_live_bridge.dashboard_runtime.load_config', return_value={'mode': 'auto'})
        self.config_patch.start()
        self.addCleanup(self.config_patch.stop)
        self.runtime = DashboardRuntime()
        self.runtime.unity = {'connected': True}
        for field in ['giftQueue', 'freeGiftQueue', 'ordinaryQueue']:
            self.runtime.unity[field] = [dict(viewerName=f'viewer-{i}', userId=f'u-{i}', score=i+1, points=i+1,
                source='kuaishou-web', waitingRounds=0, missedRegistrations=i) for i in range(235)]

    def test_light_state_omits_queue_payload_and_keeps_totals(self):
        state = self.runtime.snapshot(include_queues=False)
        self.assertEqual(state['queueTotals'], {'paid': 235, 'free': 235, 'ordinary': 235})
        self.assertLess(len(json.dumps(state)), 12000)
        self.assertNotIn('viewer-234', json.dumps(state))
        full = self.runtime.snapshot()
        self.assertEqual(len(full['giftQueue']), 235)

    def test_unchanged_revision_and_real_change(self):
        before = self.runtime.snapshot(include_queues=False)
        delta = self.runtime.snapshot(since_revision=before['revision'], include_queues=False)
        self.assertTrue(delta['unchanged'])
        self.assertLess(len(json.dumps(delta)), 500)
        self.runtime.handle_event('source_state', {'source': 'web', 'state': 'connected', 'message': 'ready'})
        changed = self.runtime.snapshot(since_revision=before['revision'], include_queues=False)
        self.assertFalse(changed.get('unchanged', False))
        self.assertGreater(changed['revision'], before['revision'])

    def test_each_queue_has_complete_pages_with_global_rank(self):
        for kind in ['paid', 'free', 'ordinary']:
            with self.subTest(kind=kind):
                rows = []
                for page in range(1, 6):
                    data = self.runtime.queue_page(kind, page, 50)
                    self.assertEqual(data['total'], 235)
                    self.assertEqual(data['page'], page)
                    self.assertEqual(data['pageSize'], 50)
                    self.assertLessEqual(len(data['rows']), 50)
                    rows += data['rows']
                self.assertEqual([row['viewerName'] for row in rows], [f'viewer-{i}' for i in range(235)])
                self.assertEqual([row['rank'] for row in rows], list(range(1, 236)))

    def test_empty_and_beyond_last_page(self):
        page = self.runtime.queue_page('paid', 999, 50)
        self.assertEqual(page['page'], 5)
        self.assertEqual(len(page['rows']), 35)
        self.runtime.unity['giftQueue'] = []
        page = self.runtime.queue_page('paid', 99, 50)
        self.assertEqual((page['page'], page['total'], page['rows']), (1, 0, []))

    def test_page_size_bounded_and_invalid_kind_rejected(self):
        self.assertLessEqual(len(self.runtime.queue_page('paid', 1, 10000)['rows']), 100)
        with self.assertRaises(ValueError): self.runtime.queue_page('not-a-queue')

    def test_http_routes_deliver_light_state_and_requested_page(self):
        server = DashboardServer(('127.0.0.1', 0), 'offline-token', self.runtime)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            def get(path):
                request = Request(f'http://127.0.0.1:{server.server_port}{path}', headers={'X-BallFight-Token': 'offline-token'})
                with urlopen(request, timeout=5) as response: return json.load(response)
            state = get('/api/state')
            self.assertNotIn('viewer-234', json.dumps(state))
            self.assertTrue(get(f"/api/state?since={state['revision']}")['unchanged'])
            page = get('/api/queue?kind=paid&page=2&pageSize=10')
            self.assertEqual(page['rows'][0]['rank'], 11)
            self.assertEqual(page['rows'][0]['viewerName'], 'viewer-10')
        finally:
            server.shutdown(); server.server_close(); worker.join(timeout=5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
