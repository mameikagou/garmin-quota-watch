import Toybox.Lang;
import Toybox.Time;
import Toybox.Time.Gregorian;

(:glance)
module QuotaData {
    const KEYS = ["codex", "claude", "gemini", "devin", "opencode", "zcode", "workbuddy"];
    const LABELS = ["GPT", "Claude", "AGY", "DEVIN", "OPENCODE", "ZCODE", "WORKBUDDY"];
    const COLORS = [0x73ebc0, 0xd97757, 0x4c8cf5, 0xb7a1f8, 0xf6be85, 0xfacc15, 0x22d3ee];

    function build(snapshot) as Array<Dictionary> {
        var result = [] as Array<Dictionary>;
        if (!(snapshot instanceof Dictionary) || !(snapshot["cards"] instanceof Array)) { return result; }
        var cards = snapshot["cards"] as Array;
        for (var index = 0; index < KEYS.size(); index++) {
            var accounts = [] as Array<Dictionary>;
            for (var position = 0; position < cards.size(); position++) {
                var account = cards[position];
                if (account instanceof Dictionary && KEYS[index].equals(account["group"]) && account["error"] == null) {
                    accounts.add(account);
                }
            }
            if (accounts.size() == 0) { continue; }
            var group = {"key" => KEYS[index], "title" => LABELS[index], "color" => COLORS[index], "accounts" => accounts};
            group["rows"] = rows(group);
            result.add(group);
        }
        return result;
    }

    function windows(key as String, account as Dictionary) as Array<Dictionary> {
        var result = [] as Array<Dictionary>;
        if (!(account["windows"] instanceof Array)) { return result; }
        var available = account["windows"] as Array;
        for (var index = 0; index < available.size(); index++) {
            var window = available[index];
            if (!(window instanceof Dictionary) || window["remaining"] == null) { continue; }
            if (key.equals("gemini") && !"Gemini".equals(window["pool"])) { continue; }
            if (key.equals("zcode")) {
                var name = window["name"] as String;
                if (name.find("GLM-5.3") == null || name.find("Flash") != null || name.find("Gift") != null) { continue; }
            }
            result.add(window);
        }
        return result;
    }

    function period(name as String) as String {
        var labels = {"7 days" => "周", "1 day" => "日", "5 hours" => "5h", "Month" => "月", "Credits" => "积分"};
        var label = labels[name];
        return label == null ? name : label;
    }

    function makeRow(label as String, window as Dictionary) as Dictionary {
        return {"label" => label, "remaining" => window["remaining"], "scale" => 100,
            "stamp" => window["resets_at_seconds"], "text" => null};
    }

    function rows(group as Dictionary) as Array<Dictionary> {
        if ("gemini".equals(group["key"])) { return geminiRows(group); }
        var result = [] as Array<Dictionary>;
        var accounts = group["accounts"] as Array<Dictionary>;
        for (var index = 0; index < accounts.size(); index++) {
            var account = accounts[index];
            var available = windows(group["key"], account);
            for (var position = 0; position < available.size(); position++) {
                var window = available[position];
                var row = makeRow(period(window["name"]), window);
                if ("zcode".equals(group["key"])) {
                    var kind = "起步";
                    if ((window["name"] as String).find("1024") != null) { kind = "活动"; }
                    row["label"] = account["account"] + " " + kind;
                }
                if ("workbuddy".equals(group["key"])) { creditRow(row, window, account["account"]); }
                result.add(row);
            }
        }
        if ("claude".equals(group["key"])) { addBalance(result, accounts); }
        return result;
    }

    function geminiRows(group as Dictionary) as Array<Dictionary> {
        var result = [] as Array<Dictionary>;
        var names = ["5 hours", "7 days"];
        var accounts = group["accounts"] as Array<Dictionary>;
        for (var index = 0; index < names.size(); index++) {
            var row = null as Dictionary?;
            for (var position = 0; position < accounts.size(); position++) {
                var available = windows("gemini", accounts[position]);
                for (var windowIndex = 0; windowIndex < available.size(); windowIndex++) {
                    var window = available[windowIndex];
                    if (!names[index].equals(window["name"])) { continue; }
                    if (row == null) {
                        row = makeRow(period(names[index]), window);
                        row["scale"] = 200;
                    } else {
                        row["remaining"] += window["remaining"];
                        var stamp = window["resets_at_seconds"];
                        if (stamp != null && (row["stamp"] == null || stamp < row["stamp"])) { row["stamp"] = stamp; }
                    }
                }
            }
            if (row != null) {
                if (row["remaining"] > 200) { row["remaining"] = 200; }
                result.add(row);
            }
        }
        return result;
    }

    function creditRow(row as Dictionary, window as Dictionary, account as String) {
        row["label"] = account;
        if (window["limit"] == null) { return; }
        var remaining = window["limit"] * window["remaining"] / 100.0;
        if (window["amount"] != null) { remaining = window["limit"] - window["amount"]; }
        row["text"] = remaining.toFloat().format("%.0f") + "/" + window["limit"].toFloat().format("%.0f");
    }

    function addBalance(result as Array<Dictionary>, accounts as Array<Dictionary>) {
        for (var index = 0; index < accounts.size(); index++) {
            var available = windows("claude", accounts[index]);
            for (var position = 0; position < available.size(); position++) {
                var window = available[position];
                if (!"USD".equals(window["unit"]) || window["amount"] == null || window["limit"] == null) { continue; }
                var balance = window["limit"] - window["amount"];
                var row = makeRow("余额", window);
                row["stamp"] = null;
                row["text"] = "$" + balance.toFloat().format("%.2f");
                result.add(row);
                return;
            }
        }
    }

    function value(row as Dictionary) as String {
        if (row["text"] != null) { return row["text"]; }
        var amount = row["remaining"];
        if (row["scale"] == 200) { amount = amount.toNumber(); }
        return amount.toFloat().format("%.0f") + "%";
    }

    function countdown(stamp) as String {
        if (stamp == null) { return ""; }
        var seconds = stamp - Time.now().value();
        if (seconds <= 0) { return "0m"; }
        if (seconds >= 86400) { return ((seconds / 86400.0) + 0.5).toNumber().toString() + "d"; }
        if (seconds >= 1800) { return ((seconds / 3600.0) + 0.5).toNumber().toString() + "h"; }
        return ((seconds / 60.0) + 0.5).toNumber().toString() + "m";
    }

    function date(stamp) as String {
        if (stamp == null) { return ""; }
        var info = Gregorian.info(new Time.Moment(stamp.toNumber()), Time.FORMAT_SHORT);
        return info.month.format("%02d") + "/" + info.day.format("%02d") + " "
            + info.hour.format("%02d") + ":" + info.min.format("%02d");
    }

    function updated(snapshot) as String {
        if (!(snapshot instanceof Dictionary) || snapshot["collected_at_seconds"] == null) { return ""; }
        var info = Gregorian.info(new Time.Moment(snapshot["collected_at_seconds"].toNumber()), Time.FORMAT_SHORT);
        return info.hour.format("%02d") + ":" + info.min.format("%02d") + " 更新";
    }

    function tiboNotice(snapshot) as Dictionary? {
        if (!(snapshot instanceof Dictionary) || !(snapshot["tibo"] instanceof Dictionary)) { return null; }
        var data = snapshot["tibo"] as Dictionary;
        var next = data["next_reset"];
        if (!(next instanceof Dictionary) || next["expected_at_seconds"] == null) { return null; }
        return {"text" => "Tibo " + countdown(next["expected_at_seconds"]) + " 后", "color" => 0xffc66d};
    }

    function glanceValue(groups as Array<Dictionary>, key as String, period as String) as Dictionary? {
        for (var index = 0; index < groups.size(); index++) {
            var group = groups[index];
            if (!key.equals(group["key"])) { continue; }
            var rows = group["rows"] as Array<Dictionary>;
            for (var position = 0; position < rows.size(); position++) {
                if (period.equals(rows[position]["label"])) { return rows[position]; }
            }
        }
        return null;
    }
}
