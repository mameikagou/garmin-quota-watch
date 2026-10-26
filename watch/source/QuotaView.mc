import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.Timer;
import Toybox.WatchUi;

class QuotaCanvas extends WatchUi.View {
    var offset = 0;
    var contentHeight = 390;
    var hits as Array<Array<Number>> = [];
    var small;
    var label;
    var number;
    var title;
    var _timer;

    function initialize() {
        View.initialize();
        small = WatchUi.loadResource(Rez.Fonts.Small);
        label = WatchUi.loadResource(Rez.Fonts.Label);
        number = WatchUi.loadResource(Rez.Fonts.Numbers);
        title = WatchUi.loadResource(Rez.Fonts.Title);
        _timer = new Timer.Timer();
    }
    function onShow() { _timer.start(method(:tick), 30000, true); }
    function onHide() { _timer.stop(); }
    function tick() { WatchUi.requestUpdate(); }
    function scroll(delta) {
        offset += delta;
        if (offset < 0) { offset = 0; }
        var maximum = contentHeight - 390;
        if (maximum < 0) { maximum = 0; }
        if (offset > maximum) { offset = maximum; }
        WatchUi.requestUpdate();
    }
    function text(dc, left, top, value, font, color) {
        dc.setColor(color, Graphics.COLOR_TRANSPARENT);
        dc.drawText(left, top, font, value, Graphics.TEXT_JUSTIFY_LEFT);
    }
    function centered(dc, top, value, font, color) {
        text(dc, 195 - dc.getTextWidthInPixels(value, font) / 2, top, value, font, color);
    }
    function safeWidth(top, height) {
        var distance = top - 195;
        if (distance < 0) { distance = -distance; }
        var bottom = top + height - 195;
        if (bottom < 0) { bottom = -bottom; }
        if (bottom > distance) { distance = bottom; }
        if (distance >= 190) { return 220; }
        var width = (2 * Math.sqrt(190 * 190 - distance * distance) - 16).toNumber();
        if (width < 220) { width = 220; }
        if (width > 300) { width = 300; }
        return width;
    }
    function box(dc, left, top, width, height) {
        dc.setColor(0x11161b, Graphics.COLOR_TRANSPARENT);
        dc.fillRoundedRectangle(left, top, width, height, 14);
        dc.setColor(0x1f2730, Graphics.COLOR_TRANSPARENT);
        dc.drawRoundedRectangle(left, top, width, height, 14);
    }
    function track(dc, bounds as Array, row as Dictionary, color) {
        var remaining = row["remaining"];
        dc.setColor(remaining == 0 ? 0x2b1717 : 0x202730, Graphics.COLOR_TRANSPARENT);
        dc.fillRoundedRectangle(bounds[0], bounds[1], bounds[2], bounds[3], 2);
        if (remaining <= 0) { return; }
        var fraction = remaining / row["scale"].toFloat();
        if (fraction > 1) { fraction = 1; }
        dc.setColor(color, Graphics.COLOR_TRANSPARENT);
        dc.fillRoundedRectangle(bounds[0], bounds[1], bounds[2] * fraction, bounds[3], 2);
    }
    function cropped(dc, value, width, font) {
        var result = value;
        while (result.length() > 0 && dc.getTextWidthInPixels(result, font) > width) {
            result = result.substring(0, result.length() - 1);
        }
        return result;
    }
}

class QuotaView extends QuotaCanvas {
    function initialize() { QuotaCanvas.initialize(); }
    function onShow() { QuotaCanvas.onShow(); getQuotaApp().refresh(); }
    function onUpdate(dc) {
        dc.setColor(0x000000, 0x000000);
        dc.clear();
        dc.setAntiAlias(true);
        hits = [];
        var groups = getQuotaApp().groups;
        var top = 50 - offset;
        dc.setClip(0, 50, 390, 340);
        for (var index = 0; index < groups.size(); index++) {
            var group = groups[index] as Dictionary;
            var rows = group["rows"] as Array<Dictionary>;
            var height = 42 + rows.size() * 44;
            if ("codex".equals(group["key"]) && QuotaData.tiboNotice(getQuotaApp().snapshot) != null) { height += 34; }
            if (top + height > 50 && top < 390) { drawCard(dc, group, top, height, index); }
            top += height + 10;
        }
        contentHeight = top + offset + 59;
        dc.clearClip();
        dc.setColor(0x000000, Graphics.COLOR_TRANSPARENT);
        dc.fillRectangle(0, 0, 390, 50);
        var stamp = QuotaData.updated(getQuotaApp().snapshot);
        if (getQuotaApp().loading) { stamp += " · 刷新中"; }
        if (getQuotaApp().status.length() > 0) { stamp += " · " + getQuotaApp().status; }
        centered(dc, 17, stamp, small, 0x9aaab8);
    }
    function drawCard(dc, group as Dictionary, top, height, index) {
        var width = safeWidth(top, height);
        var left = (390 - width) / 2;
        box(dc, left, top, width, height);
        dc.setColor(group["color"], Graphics.COLOR_TRANSPARENT);
        dc.fillCircle(left + 18, top + 22, 3);
        text(dc, left + 29, top + 6, group["title"], label, group["color"]);
        text(dc, left + width - 24, top + 6, "›", label, 0x82929e);
        var rows = group["rows"] as Array<Dictionary>;
        for (var rowIndex = 0; rowIndex < rows.size(); rowIndex++) {
            drawRow(dc, [left + 14, top + 38 + rowIndex * 44, width - 28], rows[rowIndex], group["color"]);
        }
        if ("codex".equals(group["key"])) { drawTibo(dc, [left + 14, top + 38 + rows.size() * 44, width - 28]); }
        hits.add([left, top, width, height, index]);
    }
    function drawTibo(dc, bounds as Array) {
        var notice = QuotaData.tiboNotice(getQuotaApp().snapshot);
        if (notice == null) { return; }
        dc.setColor(0x293440, Graphics.COLOR_TRANSPARENT);
        dc.drawLine(bounds[0], bounds[1], bounds[0] + bounds[2], bounds[1]);
        text(dc, bounds[0], bounds[1] + 6, notice["text"], small, notice["color"]);
    }
    function drawRow(dc, bounds as Array, row as Dictionary, accent) {
        var left = bounds[0];
        var top = bounds[1];
        var right = left + bounds[2];
        var depleted = row["remaining"] == 0;
        var color = depleted ? 0xff5252 : 0xf2f5f8;
        var countdown = QuotaData.countdown(row["stamp"]);
        if (countdown.length() > 0) {
            var timeWidth = dc.getTextWidthInPixels(countdown, small);
            text(dc, right - timeWidth, top + 9, countdown, small, depleted ? color : 0x9aaab8);
            right -= timeWidth + 5;
        }
        var value = QuotaData.value(row);
        var valueFont = row["text"] == null ? number : label;
        var valueWidth = dc.getTextWidthInPixels(value, valueFont);
        text(dc, right - valueWidth, top + (row["text"] == null ? -1 : 7), value, valueFont, color);
        var rowLabel = row["label"] as String;
        text(dc, left, top + 7, rowLabel, label, depleted ? color : 0xc0cedb);
        var start = left + dc.getTextWidthInPixels(rowLabel, label) + 7;
        var length = right - valueWidth - start - 7;
        if (length > 0) { track(dc, [start, top + 23, length, 5], row, accent); }
    }
    function tap(position as Array) {
        if (position[1] < 50) { getQuotaApp().refresh(); return; }
        for (var index = 0; index < hits.size(); index++) {
            var hit = hits[index];
            if (position[0] >= hit[0] && position[0] < hit[0] + hit[2] && position[1] >= hit[1] && position[1] < hit[1] + hit[3]) {
                var detail = new QuotaDetail(getQuotaApp().groups[hit[4]]);
                WatchUi.pushView(detail, new QuotaDelegate(detail), WatchUi.SLIDE_LEFT);
                return;
            }
        }
    }
    function back() { return false; }
}

class QuotaDetail extends QuotaCanvas {
    var _group as Dictionary;
    function initialize(group) { QuotaCanvas.initialize(); _group = group; }
    function onShow() {
        QuotaCanvas.onShow();
        getQuotaApp().refreshGroup(_group["key"] as String);
    }
    function onHide() {
        getQuotaApp().cancelDetailRefresh(_group["key"] as String);
        QuotaCanvas.onHide();
    }
    function onUpdate(dc) {
        dc.setColor(0x000000, 0x000000);
        dc.clear();
        dc.setAntiAlias(true);
        var groups = getQuotaApp().groups;
        for (var position = 0; position < groups.size(); position++) {
            if ((_group["key"] as String).equals(groups[position]["key"])) { _group = groups[position]; }
        }
        var group = _group as Dictionary;
        var top = 24 - offset;
        dc.setColor(0x161c22, Graphics.COLOR_TRANSPARENT);
        dc.fillRoundedRectangle(120, top, 150, 40, 20);
        dc.setColor(0x293440, Graphics.COLOR_TRANSPARENT);
        dc.drawRoundedRectangle(120, top, 150, 40, 20);
        centered(dc, top + 4, "‹ 返回总览", label, 0xc4d2dd);
        var headingWidth = dc.getTextWidthInPixels(group["title"], title);
        dc.setColor(group["color"], Graphics.COLOR_TRANSPARENT);
        dc.fillCircle(195 - headingWidth / 2 - 12, top + 72, 4);
        centered(dc, top + 50, group["title"], title, group["color"]);
        centered(dc, top + 80, QuotaData.updatedTime(getQuotaApp().snapshot), small,
            getQuotaApp().detailRefreshing ? 0xffc66d : 0x82929e);
        var accounts = group["accounts"] as Array<Dictionary>;
        top += 122;
        for (var index = 0; index < accounts.size(); index++) {
            top = drawAccount(dc, group, accounts[index], top, accounts.size() > 1);
        }
        contentHeight = top + offset + 16;
    }
    function drawAccount(dc, group as Dictionary, account as Dictionary, top, showName) {
        if (showName && account["account"] != null && account["account"].length() > 0) {
            centered(dc, top, account["account"], label, 0x8fa0af);
            top += 32;
        }
        var available = QuotaData.windows(group["key"], account);
        for (var index = 0; index < available.size(); index++) {
            top = drawWindow(dc, top, available[index], group);
        }
        return top + 12;
    }
    function drawWindow(dc, top, window as Dictionary, group as Dictionary) {
        var reset = QuotaData.date(window["resets_at_seconds"]);
        var height = 96;
        if (reset.length() > 0) { height += 32; }
        var width = safeWidth(top, height);
        var left = (390 - width) / 2;
        if (top + height > 0 && top < 390) {
            box(dc, left, top, width, height);
            var name = QuotaData.period(window["name"]);
            if ("zcode".equals(group["key"])) {
                name = "GLM-5.3 · 起步";
                if ((window["name"] as String).find("1024") != null) { name = "GLM-5.3 · 活动"; }
            }
            var row = QuotaData.makeRow(name, window);
            var value = QuotaData.value(row);
            var color = window["remaining"] == 0 ? 0xff5252 : 0xf2f5f8;
            text(dc, left + 14, top + 8, name, label, 0xd0dce5);
            text(dc, left + width - 14 - dc.getTextWidthInPixels(value, number), top + 34, value, number, color);
            track(dc, [left + 14, top + 84, width - 28, 5], row, group["color"]);
            if (reset.length() > 0) {
                reset += " · " + QuotaData.countdown(window["resets_at_seconds"]);
                centered(dc, top + 96, reset, small, color);
            }
        }
        return top + height + 8;
    }
    function tap(position as Array) {
        var top = position[1] + offset;
        if (top >= 24 && top < 70) { back(); }
    }
    function back() { WatchUi.popView(WatchUi.SLIDE_RIGHT); return true; }
}

(:glance)
class QuotaGlance extends WatchUi.GlanceView {
    var _label;
    var _small;
    var _number;
    function initialize() {
        GlanceView.initialize();
        _label = WatchUi.loadResource(Rez.Fonts.GlanceLabel);
        _small = WatchUi.loadResource(Rez.Fonts.GlanceSmall);
        _number = WatchUi.loadResource(Rez.Fonts.GlanceNumber);
    }
    function onUpdate(dc) {
        dc.setColor(0xf2f5f8, 0x000000);
        dc.clear();
        var width = dc.getWidth();
        var height = dc.getHeight();
        draw(dc, 5, 0, QuotaVariant.TITLE, _label, 0xf2f5f8);
        var time = QuotaData.updated(getQuotaApp().snapshot);
        draw(dc, width - dc.getTextWidthInPixels(time, _small) - 5, 4, time, _small, 0x82929e);
        var row = QuotaData.glanceValue(getQuotaApp().groups, QuotaVariant.KEY, "周");
        if (row == null) { return; }
        draw(dc, 5, 59, QuotaData.countdown(row["stamp"]) + " 后", _small, 0x82929e);
        var value = QuotaData.value(row);
        draw(dc, width - dc.getTextWidthInPixels(value, _number) - 5, 19, value, _number,
            row["remaining"] == 0 ? 0xff5252 : 0xf2f5f8);
        dc.setColor(0x202730, Graphics.COLOR_TRANSPARENT);
        dc.fillRoundedRectangle(5, 87, width - 10, 5, 2);
        dc.setColor("codex".equals(QuotaVariant.KEY) ? 0x73ebc0 : 0xd97757, Graphics.COLOR_TRANSPARENT);
        dc.fillRoundedRectangle(5, 87, (width - 10) * row["remaining"] / row["scale"], 5, 2);
        drawStatus(dc, width, height);
    }
    function drawStatus(dc, width, height) {
        if ("codex".equals(QuotaVariant.KEY)) {
            var notice = QuotaData.tiboNotice(getQuotaApp().snapshot);
            if (notice != null) {
                draw(dc, 5, height - 28, notice["text"], _small, notice["color"]);
            }
        } else {
            var balance = QuotaData.glanceValue(getQuotaApp().groups, QuotaVariant.KEY, "余额");
            if (balance != null) { draw(dc, 5, height - 46, "余额 " + QuotaData.value(balance), _label, 0xd97757); }
        }
    }
    function draw(dc, left, top, value, font, color) {
        dc.setColor(color, Graphics.COLOR_TRANSPARENT);
        dc.drawText(left, top, font, value, Graphics.TEXT_JUSTIFY_LEFT);
    }
}
