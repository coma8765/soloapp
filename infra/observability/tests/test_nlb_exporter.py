import importlib.util
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('nlb', Path(__file__).parents[1]/'files/nlb-exporter.py')
nlb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nlb)
class ExporterTest(unittest.TestCase):
    def test_failure_is_unknown_not_previous_healthy(self):
        text = nlb.metrics([], {'10.0.0.1':'yc'}, False, 100, 2).decode()
        self.assertIn('soloapp_nlb_poll_success 0', text)
        self.assertIn('state="HEALTHY"} 0', text)
        self.assertIn('state="UNKNOWN"} 1', text)
        self.assertIn('timestamp_seconds 100', text)
    def test_state_is_one_hot_and_zone_shift_is_separate(self):
        text = nlb.metrics([{'address':'10.0.0.1','status':'UNHEALTHY','zoneShifted':True}], {'10.0.0.1':'yc'}, True, 100, .1).decode()
        state = [s for s in text.splitlines() if s.startswith('soloapp_nlb_target_state')]
        self.assertEqual(sum(float(s.rsplit(' ',1)[1]) for s in state),1)
        self.assertIn('state="UNHEALTHY"} 1', text)
        self.assertIn('soloapp_nlb_target_zone_shifted{ingress="yc",address="10.0.0.1"} 1',text)
    def test_missing_or_new_api_state_is_unknown(self):
        text = nlb.metrics([{'address':'10.0.0.1','status':'NEW'}], {'10.0.0.1':'yc','10.0.0.2':'edge'}, True, 100, .1).decode()
        self.assertEqual(text.count('state="UNKNOWN"} 1'),2)
if __name__ == '__main__': unittest.main()
