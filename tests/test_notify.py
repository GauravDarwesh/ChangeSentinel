import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from regmon.notify import build_notifications, load_state, publish, save_state

class TestNotifications(unittest.TestCase):
    def test_relevant_ai_result_becomes_notification(self):
        report={"ai_results":[{
            "event_id":"1","event":"CHANGED_URL","url":"https://example.test/a",
            "ai":{"status":"ok","analysis":{
                "relevant":True,"topic":"Guideline","summary":"Changed",
                "reason":"Requirement updated","impact":"Review"
            }}
        }]}
        self.assertEqual(build_notifications(report)[0]["event_id"],"1")

    def test_removed_and_error(self):
        report={"events":[
            {"event_id":"2","event_type":"REMOVED_URL","url":"https://example.test/x"},
            {"event_id":"3","event_type":"FETCH_ERROR","url":"https://example.test/y","evidence":{"error":"HTTP 503"}}
        ]}
        values=build_notifications(report)
        self.assertEqual([x["event_id"] for x in values],["2","3"])
        self.assertIn("HTTP 503",values[1]["reason"])

    @patch("regmon.notify.requests.post")
    def test_publish(self,mock_post):
        mock_post.return_value.raise_for_status.return_value=None
        publish({
            "event_id":"x","kind":"CHANGED_URL","url":"https://example.test",
            "topic":"T","summary":"S","reason":"R","impact":"I",
            "priority":4,"tags":["warning"]
        },"topic","https://ntfy.sh","https://dash")
        kwargs=mock_post.call_args.kwargs
        self.assertEqual(kwargs["json"]["click"],"https://dash")
        self.assertIn("Impact: I",kwargs["json"]["message"])

    def test_state_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/"notifications.json"
            state={"sent_events":{"x":{}},"updated_at":None}
            save_state(state,path)
            self.assertIn("x",load_state(path)["sent_events"])

if __name__=="__main__":
    unittest.main()
