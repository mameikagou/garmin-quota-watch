import Toybox.Lang;
import Toybox.Time;

(:glance)
class QuotaPreviewApp extends QuotaApp {
    function initialize() {
        QuotaApp.initialize();
        var now = Time.now().value();
        snapshot = {"collected_at_seconds" => now, "cards" => [{"group" => "codex",
            "windows" => [{"name" => "7 days", "remaining" => 82,
                "resets_at_seconds" => now + 6 * 86400}]}], "tibo" => previewTibo()};
        groups = QuotaData.build(snapshot);
    }
    function getGlanceView() { return [new QuotaGlance()]; }
    function getInitialView() { return QuotaApp.getInitialView(); }
    function refresh() {}
    function previewTibo() as Dictionary {
        var now = Time.now().value();
        var day = ((now + 28800) / 86400).toNumber();
        var today = day * 86400 - 28800;
        var next = null;
        if (QuotaVariant.PREVIEW_CASE.equals("deadline")) {
            var deadline = today + 2 * 86400 + 3600;
            next = {"date_seconds" => today + 2 * 86400, "expected_at_seconds" => deadline,
                "through_seconds" => deadline, "precision" => "deadline", "deadline" => true,
                "status" => "announced", "confirmed" => false};
        } else if (QuotaVariant.PREVIEW_CASE.equals("date")) {
            next = {"date_seconds" => today + 86400, "precision" => "date",
                "status" => "announced", "confirmed" => false};
        } else if (QuotaVariant.PREVIEW_CASE.equals("expired")) {
            next = {"date_seconds" => today, "expected_at_seconds" => now - 3600,
                "precision" => "deadline", "deadline" => true,
                "status" => "expired_unconfirmed", "confirmed" => false};
        } else if (QuotaVariant.PREVIEW_CASE.equals("past")) {
            next = {"date_seconds" => today - 86400, "expected_at_seconds" => today - 82800,
                "precision" => "exact", "status" => "confirmed", "confirmed" => true};
        }
        return {"next_reset" => next, "last_reset" => null};
    }
}
