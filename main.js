"use strict";

var obsidian = require('obsidian');

const VIEW_TYPE_WIKICODIAN = "wikicodian-chat-view";

const DEFAULT_SETTINGS = {
    serverUrl: 'http://127.0.0.1:8000'
};

const SLASH_COMMANDS = [
    { name: "/sync", desc: "同步笔记到 AI 索引" },
    { name: "/md2canvas", desc: "将当前文件转为 Canvas (3层正则版)" },
    { name: "/md2canvas_ai", desc: "将当前文件转为 Canvas (AI 深度版)" },
    { name: "/pdf2md", desc: "PDF 智能转 Markdown (加路径)" },
    { name: "/docx2md", desc: "Word 转 Markdown (加路径)" },
    { name: "/xlsx2md", desc: "Excel 转 Markdown (加路径)" },
    { name: "/kbclear all yes", desc: "物理清空索引 + Wiki 页面" },
    { name: "/kbclear yes", desc: "仅清空本地索引碎片" },
    { name: "/kbsave", desc: "创建知识库快照备份" },
    { name: "/kbbackups", desc: "查看历史快照列表" },
    { name: "/kbrestore", desc: "恢复指定快照 (加 ID)" },
    { name: "/vaultpath", desc: "查看/设置库路径 (加路径)" },
    { name: "/structure", desc: "查看当前索引文件结构" },
    { name: "/status", desc: "监控运行状态与模型配置" },
    { name: "/model", desc: "切换 LLM 文本模型" },
    { name: "/mode", desc: "切换检索模式 (auto/wiki/...)" },
    { name: "/ask", desc: "强制 Wiki 增强检索提问" },
    { name: "/resume", desc: "恢复上一次的历史对话" },
    { name: "/memdraft", desc: "将本轮对话整理为 Wiki 草稿" },
    { name: "/memsave", desc: "将整理好的草稿保存到本地 raw/faq" },
    { name: "/reset", desc: "彻底清空当前屏幕与记忆" },
    { name: "/help", desc: "显示全量命令使用手册" }
];

class WikicodianView extends obsidian.ItemView {
    constructor(leaf, settings) {
        super(leaf);
        this.settings = settings;
        this.messages = [];
        this.suggestIndex = -1;
        this.filteredCommands = [];
        this.chatMode = "auto";
        this.currentDraft = { title: "", content: "" };
        this.inputHistory = [];
        this.historyIndex = -1;
    }

    getViewType() { return VIEW_TYPE_WIKICODIAN; }
    getDisplayText() { return "Wikicodian Chat"; }
    getIcon() { return "bot"; }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('wikicodian-chat-container');

        const statusBar = container.createEl('div', { cls: 'wikicodian-sync-bar' });
        const statusInfo = statusBar.createEl('div');
        statusInfo.createEl('span', { cls: 'wikicodian-status-dot wikicodian-status-online' });
        statusInfo.createSpan({ text: 'WikiCoder Backend Online' });

        const syncBtn = statusBar.createEl('button', { text: 'Sync Wiki', cls: 'mod-cta' });
        syncBtn.onclick = () => this.executeSlashCommand("/sync");

        const draftBtn = statusBar.createEl('button', { text: '整理记录', cls: 'mod-cta' });
        draftBtn.onclick = () => this.handleMemDraft();

        const saveBtn = statusBar.createEl('button', { text: '入库', cls: 'mod-cta' });
        saveBtn.onclick = () => this.handleMemSave();

        const modeToggle = statusBar.createEl('button', { 
            text: `Mode: ${this.chatMode.toUpperCase()}`, 
            cls: 'wikicodian-mode-toggle' 
        });
        modeToggle.onclick = () => {
            this.chatMode = this.chatMode === "build" ? "auto" : "build";
            modeToggle.setText(`Mode: ${this.chatMode.toUpperCase()}`);
            modeToggle.toggleClass('is-build', this.chatMode === "build");
            new obsidian.Notice(`已切换到 ${this.chatMode.toUpperCase()} 模式`);
        };

        this.messageContainer = container.createEl('div', { cls: 'wikicodian-chat-messages' });
        this.suggestContainer = container.createEl('div', { cls: 'wikicodian-suggest-container' });
        this.suggestContainer.style.display = 'none';

        const inputArea = container.createEl('div', { cls: 'wikicodian-chat-input-area' });
        this.inputEl = inputArea.createEl('textarea', { 
            cls: 'wikicodian-chat-input',
            attr: { placeholder: '输入 / 唤起全量 WikiCoder 命令...' }
        });
        const sendBtn = inputArea.createEl('button', { text: 'Send', cls: 'mod-cta' });

        const handleSend = async () => {
            const query = this.inputEl.value.trim();
            if (!query) return;
            if (query.startsWith("/")) {
                this.executeSlashCommand(query);
                // 记录历史
                if (this.inputHistory[0] !== query) {
                    this.inputHistory.unshift(query);
                    if (this.inputHistory.length > 50) this.inputHistory.pop();
                }
                this.historyIndex = -1;
                this.inputEl.value = '';
                this.hideSuggest();
                return;
            }
            // 记录历史
            if (this.inputHistory[0] !== query) {
                this.inputHistory.unshift(query);
                if (this.inputHistory.length > 50) this.inputHistory.pop();
            }
            this.historyIndex = -1;
            this.inputEl.value = '';
            this.appendMessage('user', (this.chatMode === "wiki_only" ? "🏠 [WIKI] " : "") + query);
            
            const statusEl = this.messageContainer.createEl('div', { cls: 'wikicodian-message wikicodian-status-msg' });
            let seconds = 0;
            statusEl.setText(`工作中......(0s)`);
            const timer = window.setInterval(() => {
                seconds++;
                statusEl.setText(`工作中......(${seconds}s)`);
            }, 1000);

            try {
                const response = await fetch(`${this.settings.serverUrl}/v1/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query, mode: this.chatMode, history: this.messages.slice(-5) })
                });
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let hasStarted = false;
                let botMsgEl = null;
                let fullContent = "";
                if (reader) {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const chunk = decoder.decode(value);
                        const lines = chunk.split('\n');
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const dataStr = line.slice(6).trim();
                                if (dataStr === '[DONE]') continue;
                                try {
                                    const json = JSON.parse(dataStr);
                                    if (json.error) {
                                        this.appendMessage('bot', `### ❌ 执行错误\n${json.error}`);
                                        return;
                                    }
                                    if (!hasStarted) {
                                        hasStarted = true;
                                        window.clearInterval(timer);
                                        statusEl.remove();
                                        botMsgEl = this.appendMessage('bot', '');
                                    }
                                    if (json.status) {
                                        botMsgEl.empty();
                                        obsidian.MarkdownRenderer.renderMarkdown(json.status, botMsgEl, '', this);
                                    }
                                    if (json.output) {
                                        fullContent += json.output;
                                        botMsgEl.empty();
                                        obsidian.MarkdownRenderer.renderMarkdown(fullContent, botMsgEl, '', this);
                                    }
                                } catch(e) {
                                    console.error("JSON parse error", e, dataStr);
                                }
                            }
                        }
                    }
                }
                // 流式结束后，记录完整的 bot 回答
                if (fullContent) {
                    this.messages.push({ q: query, a: fullContent });
                    if (this.messages.length > 20) this.messages.shift();
                }
            } catch (e) {
                window.clearInterval(timer);
                statusEl.remove();
                this.appendMessage('bot', `### ❌ 连接错误\n请检查后端 \`serve\` 服务。`);
            }
        };

        sendBtn.onclick = handleSend;
        this.inputEl.addEventListener('input', () => {
            const val = this.inputEl.value;
            if (val.startsWith("/")) this.showSuggest(val);
            else this.hideSuggest();
        });
        this.inputEl.addEventListener('keydown', (e) => {
            const isSuggestVisible = this.suggestContainer.style.display !== 'none';
            if (isSuggestVisible) {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.suggestIndex = (this.suggestIndex + 1) % this.filteredCommands.length;
                    this.renderSuggest();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.suggestIndex = (this.suggestIndex - 1 + this.filteredCommands.length) % this.filteredCommands.length;
                    this.renderSuggest();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.hideSuggest();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (this.suggestIndex >= 0) {
                        this.executeSlashCommand(this.filteredCommands[this.suggestIndex].name);
                        this.inputEl.value = '';
                        this.hideSuggest();
                    } else handleSend();
                }
            } else {
                // 处理提问历史记录导航 (建议列表未唤起时)
                if (e.key === 'ArrowUp') {
                    if (this.inputHistory.length > 0) {
                        e.preventDefault();
                        this.historyIndex = Math.min(this.historyIndex + 1, this.inputHistory.length - 1);
                        this.inputEl.value = this.inputHistory[this.historyIndex];
                    }
                } else if (e.key === 'ArrowDown') {
                    if (this.inputHistory.length > 0) {
                        e.preventDefault();
                        this.historyIndex = Math.max(this.historyIndex - 1, -1);
                        this.inputEl.value = this.historyIndex === -1 ? "" : this.inputHistory[this.historyIndex];
                    }
                } else if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                }
            }
        });
    }

    showSuggest(val) {
        this.filteredCommands = SLASH_COMMANDS.filter(c => c.name.startsWith(val.toLowerCase()));
        if (this.filteredCommands.length > 0) {
            this.suggestIndex = 0;
            this.renderSuggest();
            this.suggestContainer.style.display = 'block';
        } else this.hideSuggest();
    }
    hideSuggest() { 
        this.suggestContainer.style.display = 'none'; 
        this.suggestIndex = -1;
    }
    renderSuggest() {
        this.suggestContainer.empty();
        this.filteredCommands.forEach((cmd, idx) => {
            const item = this.suggestContainer.createEl('div', { cls: 'wikicodian-suggest-item' });
            if (idx === this.suggestIndex) item.addClass('is-selected');
            item.createEl('span', { text: cmd.name, cls: 'wikicodian-suggest-name' });
            item.createEl('span', { text: cmd.desc, cls: 'wikicodian-suggest-desc' });
            item.onclick = () => {
                this.executeSlashCommand(cmd.name);
                this.inputEl.value = '';
                this.hideSuggest();
            };
        });
    }

    async executeSlashCommand(cmd) {
        if (cmd === "/reset") {
            this.messages = [];
            this.messageContainer.empty();
            this.appendMessage('bot', "### 🔄 对话已重置");
            return;
        }
        if (cmd === "/sync") {
            const statusEl = this.appendMessage('bot', "⏳ 正在同步 Wiki 索引...");
            try {
                const res = await obsidian.requestUrl({
                    url: `${this.settings.serverUrl}/v1/sync`,
                    method: 'POST'
                });
                statusEl.remove();
                if (res.status === 200) {
                    const r = res.json.results;
                    this.appendMessage('bot', `### ✅ 同步完成\n- 修改文件: ${r.files}\n- 生成分片: ${r.chunks}\n- Wiki页面: ${r.wiki_pages}`);
                }
            } catch (e) {
                statusEl.remove();
                this.appendMessage('bot', "### ❌ 同步失败");
            }
            return;
        }
        if (cmd === "/memdraft") {
            this.handleMemDraft();
            return;
        }
        if (cmd === "/memsave") {
            this.handleMemSave();
            return;
        }
        this.appendMessage('user', cmd);
        try {
            const res = await obsidian.requestUrl({
                url: `${this.settings.serverUrl}/v1/exec`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: cmd })
            });
            if (res.status === 200) {
                const output = res.json.output || "执行成功";
                this.appendMessage('bot', output);
                if (output.includes("FILE_PATH:")) {
                    const lines = output.split('\n');
                    for (const line of lines) {
                        if (line.startsWith("FILE_PATH:")) {
                            const absPath = line.replace("FILE_PATH:", "").trim();
                            this.openExternalOrLocalFile(absPath);
                        }
                    }
                }
            }
        } catch (e) {
            this.appendMessage('bot', "### ❌ 执行失败");
        }
    }

    async handleMemDraft() {
        if (this.messages.length === 0) {
            new obsidian.Notice("当前暂无可整理的对话内容");
            return;
        }
        const statusEl = this.appendMessage('bot', "⏳ 正在整理对话并生成 Wiki 草稿...");
        try {
            const res = await obsidian.requestUrl({
                url: `${this.settings.serverUrl}/v1/memdraft`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    history: this.messages.slice(-10).map(m => ({ q: m.q, a: m.a })) 
                })
            });
            statusEl.remove();
            if (res.status === 200 && res.json.status === "success") {
                const draft = res.json.draft;
                const title = res.json.title;
                this.currentDraft = { title, content: draft };
                this.appendMessage('bot', `### ✅ 已生成 Wiki 草稿：${title}\n\n${draft}\n\n> [!TIP]\n> 点击上方 **[入库]** 按钮即可保存到本地知识库。`);
            } else {
                this.appendMessage('bot', `### ❌ 整理失败\n${res.json.message || "请求异常"}`);
            }
        } catch (e) {
            statusEl.remove();
            this.appendMessage('bot', "### ❌ 连接后端失败");
        }
    }

    async handleMemSave() {
        if (!this.currentDraft.content) {
            new obsidian.Notice("请先点击 [整理记录] 生成草稿");
            return;
        }
        try {
            const res = await obsidian.requestUrl({
                url: `${this.settings.serverUrl}/v1/memsave`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    title: this.currentDraft.title, 
                    content: this.currentDraft.content 
                })
            });
            if (res.status === 200 && res.json.status === "success") {
                new obsidian.Notice(`✅ 入库成功: ${res.json.path}`);
                this.appendMessage('bot', `### ✨ 已入库\n文件路径: \`${res.json.path}\`\n请执行 \`/sync\` 将其纳入检索。`);
                this.currentDraft = { title: "", content: "" }; // 清空已保存的草稿
            } else {
                this.appendMessage('bot', `### ❌ 保存失败\n${res.json.message || "请求异常"}`);
            }
        } catch (e) {
            this.appendMessage('bot', "### ❌ 连接后端失败");
        }
    }

    async openExternalOrLocalFile(absPath) {
        const adapter = this.app.vault.adapter;
        const vaultPath = (adapter.basePath || "").replace(/\\/g, '/');
        const normalizedAbs = absPath.replace(/\\/g, '/');
        if (normalizedAbs.startsWith(vaultPath)) {
            const relativePath = normalizedAbs.slice(vaultPath.length).replace(/^\//, '');
            const file = this.app.vault.getAbstractFileByPath(relativePath);
            if (file instanceof obsidian.TFile) {
                this.app.workspace.getLeaf(true).openFile(file);
                new obsidian.Notice(`已打开文件: ${file.name}`);
            }
        } else {
            if (window.electron) window.electron.remote.shell.openPath(absPath);
        }
    }

    appendMessage(role, text) {
        const cleanText = text.split('\n').filter(l => !l.startsWith("FILE_PATH:")).join('\n');
        const msgEl = this.messageContainer.createEl('div', { cls: `wikicodian-message wikicodian-message-${role}` });
        if (role === 'user') {
            msgEl.setText(cleanText);
        } else {
            obsidian.MarkdownRenderer.renderMarkdown(cleanText, msgEl, '', this);
        }
        this.messageContainer.scrollTo(0, this.messageContainer.scrollHeight);
        return msgEl;
    }
}

class WikicodianPlugin extends obsidian.Plugin {
    async onload() {
        await this.loadSettings();
        this.registerView(VIEW_TYPE_WIKICODIAN, (leaf) => new WikicodianView(leaf, this.settings));
        this.addRibbonIcon('bot', 'Wikicodian Chat', () => this.activateView());
        this.addCommand({
            id: 'wikicoder-convert-to-canvas',
            name: 'WikiCoder: Convert current file to Canvas (Regex)',
            callback: () => this.runCanvasConversion(false)
        });
        this.addCommand({
            id: 'wikicoder-convert-to-canvas-ai',
            name: 'WikiCoder: Convert current file to Canvas (AI)',
            callback: () => this.runCanvasConversion(true)
        });
        this.addSettingTab(new WikicodianSettingTab(this.app, this));
    }
    async runCanvasConversion(useAi) {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') {
            new obsidian.Notice("请先打开一个 Markdown 文件");
            return;
        }
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_WIKICODIAN);
        if (leaves.length === 0) await this.activateView();
        const cmd = useAi ? `/md2canvas_ai ${activeFile.path}` : `/md2canvas ${activeFile.path}`;
        const finalLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_WIKICODIAN)[0];
        if (finalLeaf) finalLeaf.view.executeSlashCommand(cmd);
    }
    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_WIKICODIAN)[0];
        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                leaf = rightLeaf;
                await leaf.setViewState({ type: VIEW_TYPE_WIKICODIAN, active: true });
            }
        }
        if (leaf) workspace.revealLeaf(leaf);
    }
    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }
}

class WikicodianSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        new obsidian.Setting(containerEl).setName('Backend URL').addText(text => text.setValue(this.plugin.settings.serverUrl).onChange(async (v) => {
            this.plugin.settings.serverUrl = v;
            await this.plugin.saveSettings();
        }));
    }
}

module.exports = WikicodianPlugin;
