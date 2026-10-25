import Toybox.Time;

(:glance)
class QuotaPreviewApp extends QuotaApp {
    function initialize() { QuotaApp.initialize(); }
    function getGlanceView() { return [new QuotaGlance()]; }
    function getInitialView() { return QuotaApp.getInitialView(); }
    function onReceive(code, data) {
        if (code == 200 && data instanceof Toybox.Lang.Dictionary) {
            data["tibo"] = {"source" => "AIHOT", "demo" => true,
                "next_reset" => {"expected_at_seconds" => Time.now().value() + 7200, "status" => "announced"},
                "last_reset" => null};
        }
        QuotaApp.onReceive(code, data);
    }
}
