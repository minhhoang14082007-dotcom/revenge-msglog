(function (exports) {
	"use strict";

	var React = revenge.react.React;
	var h = React.createElement;
	var RN = revenge.react.ReactNative;
	var onFlux = revenge.discord.flux.onFluxEventDispatched;
	var Stores = revenge.discord.flux.Stores;
	var Dispatcher = revenge.discord.common.flux.Dispatcher;

	var EPHEMERAL = 64;
	var MAX_ENTRIES = 5000;

	// id -> { channelId, deleted, ts, record, edits }
	var logs = new Map();
	var bypassed = new Set();
	var storage = null;

	function MessageStore() {
		return Stores.MessageStore;
	}
	function AuthStore() {
		return Stores.AuthenticationStore;
	}

	function slim(record) {
		return {
			id: record.id,
			channel_id: record.channel_id,
			content: record.content || "",
			timestamp: record.timestamp || null,
			type: record.type || 0,
			flags: record.flags || 0,
			author: record.author
				? {
						id: record.author.id,
						username: record.author.username,
						globalName: record.author.globalName || null,
						bot: !!record.author.bot,
					}
				: null,
			attachments: (record.attachments || []).map(function (a) {
				return {
					id: a.id,
					filename: a.filename,
					url: a.url,
					content_type: a.content_type || null,
					width: a.width || null,
					height: a.height || null,
				};
			}),
		};
	}

	function serialize() {
		var m = {};
		logs.forEach(function (log, id) {
			m[id] = {
				c: log.channelId,
				d: log.deleted,
				t: log.ts,
				r: log.record,
				e: log.edits,
			};
		});
		return { v: 1, m: m };
	}

	// jsonStorage.set persists to the plugin storage file in the app data dir.
	function persist() {
		if (!storage) return;
		var m = serialize().m;
		var ids = Object.keys(m);
		if (ids.length > MAX_ENTRIES) {
			ids.sort(function (a, b) {
				return (m[a].t || 0) - (m[b].t || 0);
			});
			var drop = ids.slice(0, ids.length - MAX_ENTRIES);
			for (var i = 0; i < drop.length; i++) {
				delete m[drop[i]];
				logs.delete(drop[i]);
			}
		}
		Promise.resolve(storage.set({ m: m }, true)).catch(function () {});
	}

	function logOf(record) {
		var log = logs.get(record.id);
		if (!log) {
			log = {
				channelId: record.channel_id,
				deleted: false,
				ts: record.timestamp ? Date.parse(record.timestamp) || Date.now() : Date.now(),
				record: slim(record),
				edits: [],
			};
			logs.set(record.id, log);
		}
		return log;
	}

	function shouldLog(record) {
		var s = settings();
		if (s.ignoreBots && record.author && record.author.bot) return false;
		if (s.ignoreSelf && record.author && record.author.id === AuthStore().getId())
			return false;
		return true;
	}

	function keepDeleted(channelId, id) {
		var record = MessageStore().getMessage(channelId, id);
		if (!record || bypassed.has(id)) return false;
		if (logs.get(id) && logs.get(id).deleted) return true;
		if (record.state !== "SENT" || (record.flags || 0) & EPHEMERAL) return false;
		if (!shouldLog(record)) return false;
		var log = logOf(record);
		log.deleted = true;
		persist();
		return true;
	}

	function rerender(channelId, id, guildId) {
		return {
			type: "MESSAGE_UPDATE",
			guildId: guildId,
			message: { id: id, channel_id: channelId },
		};
	}

	function settings() {
		var s = (storage && storage.cache && storage.cache.s) || {};
		return { ignoreSelf: !!s.ignoreSelf, ignoreBots: !!s.ignoreBots };
	}

	function intercept() {
		return [
			onFlux("MESSAGE_DELETE", function (payload) {
				var id = payload.id;
				var channelId = payload.channelId;
				if (!keepDeleted(channelId, id)) return payload;
				return rerender(channelId, id, payload.guildId);
			}),
			onFlux("MESSAGE_DELETE_BULK", function (payload) {
				var ids = payload.ids || [];
				var channelId = payload.channelId;
				var kept = [];
				for (var i = 0; i < ids.length; i++)
					if (keepDeleted(channelId, ids[i])) kept.push(ids[i]);
				if (!kept.length) return payload;
				// Can't dispatch in the middle of a dispatch
				Promise.resolve().then(function () {
					for (var j = 0; j < kept.length; j++)
						Dispatcher.dispatch(rerender(channelId, kept[j], payload.guildId));
				});
				var rest = ids.filter(function (id) {
					return kept.indexOf(id) === -1;
				});
				if (rest.length) return Object.assign({}, payload, { ids: rest });
				return payload;
			}),
			onFlux("MESSAGE_UPDATE", function (payload) {
				var update = payload.message;
				if (!update || !update.id) return payload;
				var record = MessageStore().getMessage(update.channel_id, update.id);
				if (!record || bypassed.has(update.id)) return payload;
				if (
					record.content &&
					update.content !== undefined &&
					update.content !== record.content
				) {
					var log = logOf(record);
					log.edits.push(slim(record));
					persist();
				}
				return payload;
			}),
		];
	}

	// Restores persisted logs into memory and re-marks messages the client still
	// has in its store, so they show up again after an app restart.
	function hydrate() {
		var data = (storage.cache && storage.cache.m) || {};
		var ids = Object.keys(data);
		var shown = 0;
		for (var i = 0; i < ids.length; i++) {
			var id = ids[i];
			var e = data[id];
			if (!e || logs.has(id)) continue;
			logs.set(id, {
				channelId: e.c,
				deleted: !!e.d,
				ts: e.t || 0,
				record: e.r,
				edits: e.e || [],
			});
			if (e.d) {
				var record = MessageStore().getMessage(e.c, id);
				if (record) {
					shown++;
					Dispatcher.dispatch(rerender(e.c, id));
				}
			}
		}
		return shown;
	}

	function archived() {
		var out = [];
		logs.forEach(function (log, id) {
			if (!log.deleted) return;
			out.push({ id: id, log: log });
		});
		out.sort(function (a, b) {
			return (b.log.ts || 0) - (a.log.ts || 0);
		});
		return out;
	}

	var COLORS = {
		text: "#dbdee1",
		muted: "#949ba4",
		green: "#23a55a",
	};

	function SettingsComponent() {
		storage.use();
		var items = archived();
		var children = [
			h(
				RN.Text,
				{ key: "title", style: { color: COLORS.text, fontSize: 18, marginBottom: 4 } },
				"Deleted messages archive",
			),
			h(
				RN.Text,
				{ key: "sub", style: { color: COLORS.muted, fontSize: 13, marginBottom: 12 } },
				items.length +
					" saved, kept on disk in the plugin storage. Rows restart-safe: only while Discord still has the message cached.",
			),
		];
		if (!items.length) {
			children.push(
				h(
					RN.Text,
					{ key: "empty", style: { color: COLORS.muted, fontSize: 14 } },
					"Nothing logged yet.",
				),
			);
		}
		for (var i = 0; i < items.length && i < 300; i++) {
			var it = items[i];
			var r = it.log.record || {};
			var author = r.author ? r.author.username || r.author.id : "unknown";
			var when = it.log.ts
				? new Date(it.log.ts).toLocaleString()
				: "unknown time";
			var att = r.attachments && r.attachments.length
				? " [" + r.attachments.length + " attachment(s)]"
				: "";
			children.push(
				h(
					RN.View,
					{
						key: it.id,
						style: {
							paddingVertical: 8,
							borderTopWidth: 1,
							borderTopColor: "#2b2d31",
						},
					},
					h(
						RN.Text,
						{ style: { color: COLORS.muted, fontSize: 12 } },
						author + " · " + when + " · " + it.log.channelId,
					),
					h(
						RN.Text,
						{ style: { color: COLORS.text, fontSize: 14 } },
						(r.content || "(no text)") + att,
					),
					it.log.edits.length
						? h(
								RN.Text,
								{ style: { color: COLORS.muted, fontSize: 12 } },
								it.log.edits.length + " earlier version(s)",
							)
						: null,
				),
			);
		}
		return h(
			revenge.components.Page,
			null,
			h(RN.ScrollView, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 32 } }, children),
		);
	}

	plugin({
		jsonStorage: {
			load: true,
			default: { s: { ignoreSelf: false, ignoreBots: false }, m: {} },
		},
		SettingsComponent: SettingsComponent,
		start: function (api) {
			storage = api.jsonStorage;
			var subs = intercept();
			var shown = 0;
			Promise.resolve(storage.get())
				.then(function () {
					shown = hydrate();
				})
				.catch(function (e) {
					api.plugin.reportError(
						"Message Logger (File): failed to load archive: " +
							revenge.utils.error.getErrorStack(e),
					);
				});
			api.cleanup.apply(null, subs.concat([
				function () {
					logs.clear();
					bypassed.clear();
				},
			]));
		},
	});
})({});
