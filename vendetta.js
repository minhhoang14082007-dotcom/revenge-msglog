(() => {
    const { metro, patcher, plugin, logger } = vendetta;
    const { React, ReactNative: RN, FluxDispatcher } = metro.common;
    const h = React.createElement;
    let stop;
    const account = () => metro.findByStoreName('UserStore').getCurrentUser()?.id;
    function capture(event) {
        if (!['MESSAGE_DELETE', 'MESSAGE_DELETE_BULK', 'MESSAGE_UPDATE'].includes(event?.type)) return;
        const uid = account();
        if (!uid) return;
        const channel = event.channelId || event.message?.channel_id;
        const store = metro.findByStoreName('MessageStore');
        const rows = [];
        for (const id of event.ids || [event.id || event.message?.id]) {
            const m = store.getMessage(channel, id);
            if (!m || (m.flags & 64)) continue;
            const edited = event.type === 'MESSAGE_UPDATE';
            if (edited && (typeof event.message.content !== 'string' || event.message.content === m.content)) continue;
            rows.push({id, channel, edited, author: m.author?.username || '', text: m.content || '', attachments: (m.attachments || []).map(a => a.filename), at: Date.now()});
        }
        if (rows.length) plugin.storage[uid] = [...(plugin.storage[uid] || []), ...rows];
    }
    return {
        onLoad() { stop = patcher.before('dispatch', FluxDispatcher, ([event]) => { try { capture(event); } catch (e) { logger.error(e); } }); },
        onUnload() { stop?.(); },
        settings() {
            const data = [...(plugin.storage[account()] || [])].reverse();
            return h(RN.FlatList, {data, keyExtractor: (_, i) => String(i), ListEmptyComponent: h(RN.Text, {style:{color:'#999', padding:16}}, 'Chưa có tin đã lưu.'), renderItem: ({item}) => h(RN.Text, {selectable:true, style:{color:'#bbb',padding:12}}, `${item.author} · ${item.edited ? 'trước khi sửa' : 'đã xoá'}\n${[item.text, ...item.attachments].filter(Boolean).join('\n')}`)});
        }
    };
})()
