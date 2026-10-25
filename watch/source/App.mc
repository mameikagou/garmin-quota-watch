import Toybox.Application;
import Toybox.Communications;
import Toybox.Lang;
import Toybox.System;
import Toybox.WatchUi;

(:glance)
class QuotaApp extends Application.AppBase {
    var snapshot = null;
    var loading = false;
    var status = "";
    var groups as Array<Dictionary> = [];

    function initialize() {
        AppBase.initialize();
        snapshot = Application.Storage.getValue("quota");
        groups = QuotaData.build(snapshot);
    }

    function getInitialView() {
        var view = new QuotaView();
        return [view, new QuotaDelegate(view)];
    }

    function getGlanceView() {
        return [new QuotaGlance()];
    }

    function refresh() {
        if (loading) { return; }
        var token = Application.Properties.getValue("ReadToken");
        var endpoint = Application.Properties.getValue("QuotaEndpoint");
        if (!(token instanceof String) || token.length() == 0 || !(endpoint instanceof String) || endpoint.length() == 0) {
            status = "更新失败";
            WatchUi.requestUpdate();
            return;
        }
        loading = true;
        status = "";
        WatchUi.requestUpdate();
        Communications.makeWebRequest(endpoint + "/quota", null, {
            :method => Communications.HTTP_REQUEST_METHOD_GET,
            :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON,
            :headers => {"Authorization" => "Bearer " + token}
        }, method(:onReceive));
    }

    function onReceive(code as Number, data as Dictionary or String or Null) as Void {
        loading = false;
        if (code == 200 && data instanceof Dictionary && data["cards"] instanceof Array) {
            snapshot = data;
            groups = QuotaData.build(data);
            Application.Storage.setValue("quota", data);
            status = "";
        } else {
            status = "离线";
        }
        WatchUi.requestUpdate();
    }
}

(:glance)
function getQuotaApp() as QuotaApp {
    return Application.getApp() as QuotaApp;
}

class QuotaDelegate extends WatchUi.InputDelegate {
    var _view as QuotaView or QuotaDetail;
    var _lastY = 0;
    var _lastDrag = -1000;
    function initialize(view) { InputDelegate.initialize(); _view = view; }
    function onTap(event) { _view.tap(event.getCoordinates()); return true; }
    function onHold(event) { getQuotaApp().refresh(); return true; }
    function onDrag(event) {
        var position = event.getCoordinates();
        if (event.getType() != WatchUi.DRAG_TYPE_START) { _view.scroll(_lastY - position[1]); }
        _lastY = position[1];
        _lastDrag = System.getTimer();
        return true;
    }
    function onSwipe(event) {
        var direction = event.getDirection();
        if (direction == WatchUi.SWIPE_RIGHT) { return _view.back(); }
        if (System.getTimer() - _lastDrag < 250) { return true; }
        if (direction == WatchUi.SWIPE_UP) { _view.scroll(120); }
        if (direction == WatchUi.SWIPE_DOWN) { _view.scroll(-120); }
        return true;
    }
    function onKey(event) {
        if (event.getKey() == WatchUi.KEY_ESC) { return _view.back(); }
        if (event.getKey() == WatchUi.KEY_DOWN) { _view.scroll(120); return true; }
        if (event.getKey() == WatchUi.KEY_UP) { _view.scroll(-120); return true; }
        return false;
    }
}
