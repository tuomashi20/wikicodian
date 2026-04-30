import { Plugin, PluginSettingTab, Setting, ItemView, MarkdownRenderer, requestUrl, WorkspaceLeaf, TFile, Notice, FileSystemAdapter } from 'obsidian';

// --- 常量声明 ---
const VIEW_TYPE_WIKICODIAN = "wikicodian-chat-view";

interface WikicodianSettings {
    serverUrl: string;
}

const DEFAULT_SETTINGS: WikicodianSettings = {
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
    { name: "/mode auto", desc: "切换到智能问答模式" },
    { name: "/mode build", desc: "切换到全自动智能构建模式 (支持执行)" },
    { name: "/ask", desc: "强制 Wiki 增强检索提问" },
    { name: "/resume", desc: "恢复上一次的历史对话" },
    { name: "/reset", desc: "彻底清空当前屏幕与记忆" },
    { name: "/help", desc: "显示全量命令使用手册" }
];

// --- 视图实现 ---
class WikicodianView extends ItemView {
    settings: WikicodianSettings;
    messages: any[] = [];
    suggestIndex: number = -1;
    filteredCommands: any[] = [];
    chatMode: string = "plan";
    messageContainer: HTMLElement;
    inputEl: HTMLTextAreaElement;
    suggestContainer: HTMLElement;
    taskContainer: HTMLElement;
    fileTagEl: HTMLElement;
    currentActiveFile: TFile | null = null;
    updateActiveFileUI: () => void;
    allSeenTasks: string[] = [];
    completedTasks: Set<string> = new Set();

    constructor(leaf: WorkspaceLeaf, settings: WikicodianSettings) {
        super(leaf);
        this.settings = settings;
    }

    getViewType() { return VIEW_TYPE_WIKICODIAN; }
    getDisplayText() { return "Wikicodian Chat"; }
    getIcon() { return "bot"; }

    async onOpen() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('wikicodian-chat-container');

        // 状态栏
        const statusBar = container.createEl('div', { cls: 'wikicodian-sync-bar' });
        const statusInfo = statusBar.createEl('div');
        statusInfo.createEl('span', { cls: 'wikicodian-status-dot wikicodian-status-online' });
        statusInfo.createSpan({ text: 'WikiCoder Backend Online' });

        const syncBtn = statusBar.createEl('button', { text: 'Sync Wiki', cls: 'mod-cta' });
        syncBtn.onclick = () => this.executeSlashCommand("/sync");

        // 固定的任务清单区域
        this.taskContainer = container.createEl('div', { cls: 'wikicodian-task-panel' });
        (this.taskContainer as any).style.display = 'none';

        // 消息区域
        this.messageContainer = container.createEl('div', { cls: 'wikicodian-chat-messages' });

        // 命令建议
        this.suggestContainer = container.createEl('div', { cls: 'wikicodian-suggest-container' });
        (this.suggestContainer as any).style.display = 'none';

        // 输入区域外部包装器 (仿 Claudian)
        const inputWrapper = container.createEl('div', { cls: 'wikicodian-input-wrapper' });

        this.inputEl = inputWrapper.createEl('textarea', { 
            cls: 'wikicodian-chat-input',
            attr: { placeholder: 'What\'s new, 老板?' }
        }) as HTMLTextAreaElement;

        // 底部控制栏
        const controlBar = inputWrapper.createEl('div', { cls: 'wikicodian-control-bar' });

        // 左侧控制区 (下拉模式菜单 + 文件标签)
        const controlLeft = controlBar.createEl('div', { cls: 'wikicodian-control-left' });

        // 模式选择下拉菜单
        const modeSelect = controlLeft.createEl('select', { cls: 'wikicodian-mode-select' });
        const modes = [
            { id: 'plan', label: '📝 Plan' },
            { id: 'build', label: '🚀 Build' }
        ];
        modes.forEach(m => {
            const opt = modeSelect.createEl('option', { value: m.id, text: m.label });
            if (this.chatMode === m.id) opt.selected = true;
        });
        modeSelect.onchange = (e) => {
            this.chatMode = (e.target as HTMLSelectElement).value;
        };

        // 附件文件标签
        this.fileTagEl = controlLeft.createEl('div', { cls: 'wikicodian-file-tag' });
        this.updateActiveFileUI = () => {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                this.currentActiveFile = activeFile;
                this.fileTagEl.empty();
                this.fileTagEl.createEl('span', { text: '📄', cls: 'wikicodian-file-icon' });
                this.fileTagEl.createEl('span', { text: activeFile.basename + '.' + activeFile.extension });
                
                const closeBtn = this.fileTagEl.createEl('span', { text: '✕', cls: 'wikicodian-file-close' });
                closeBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.currentActiveFile = null;
                    this.fileTagEl.style.display = 'none';
                };
                
                this.fileTagEl.style.display = 'flex';
            } else {
                this.currentActiveFile = null;
                this.fileTagEl.style.display = 'none';
            }
        };
        this.updateActiveFileUI();
        this.registerEvent(this.app.workspace.on('file-open', this.updateActiveFileUI));

        // 右侧控制区
        const controlRight = controlBar.createEl('div', { cls: 'wikicodian-control-right' });
        const interruptBtn = controlRight.createEl('button', { text: '⏹ 中断', cls: 'wikicodian-yolo-btn' });
        interruptBtn.style.display = 'none';
        
        let currentAbortController: AbortController | null = null;
        
        interruptBtn.onclick = () => {
            if (currentAbortController) {
                currentAbortController.abort();
                currentAbortController = null;
            }
        };

        const getActiveFileContext = (): string => {
            if (this.currentActiveFile && this.app.vault.adapter instanceof FileSystemAdapter) {
                return this.app.vault.adapter.getFullPath(this.currentActiveFile.path);
            }
            return "";
        };

        const handleSend = async () => {
            let query = this.inputEl.value.trim();
            if (!query) return;

            if (query.startsWith("/")) {
                this.executeSlashCommand(query);
                this.inputEl.value = '';
                this.hideSuggest();
                return;
            }

            this.inputEl.value = '';
            
            const attachedPath = getActiveFileContext();
            let displayQuery = query;
            let backendQuery = query;
            
            if (attachedPath) {
                displayQuery = `📎 **附件**: \`${this.currentActiveFile?.basename}.${this.currentActiveFile?.extension}\`\n${query}`;
                backendQuery = `[附言：当前我在屏幕上正在浏览和编辑该文件：${attachedPath}，请以此作为上下文参考]\n\n${query}`;
            }

            this.appendMessage('user', displayQuery);
            
            const statusEl = this.messageContainer.createEl('div', { cls: 'wikicodian-message wikicodian-status-msg' });
            let seconds = 0;
            statusEl.setText(`工作中......(0s)`);
            const timer = window.setInterval(() => {
                seconds++;
                statusEl.setText(`工作中......(${seconds}s)`);
            }, 1000);

            interruptBtn.style.display = 'block';
            currentAbortController = new AbortController();

            try {
                const response = await fetch(`${this.settings.serverUrl}/v1/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: backendQuery, mode: this.chatMode, history: this.messages.slice(-5) }),
                    signal: currentAbortController.signal
                });

                const reader = response.body?.getReader();
                const decoder = new TextDecoder();
                let hasStarted = false;
                let botMsgEl: HTMLElement | null = null;
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
                                    if (!hasStarted) {
                                        hasStarted = true;
                                        window.clearInterval(timer);
                                        statusEl.remove();
                                        botMsgEl = this.appendMessage('bot', '...');
                                    }
                                    
                                    if (json.tasks && Array.isArray(json.tasks)) {
                                        this.updateTasks(json.tasks);
                                    }
                                    
                                    if (json.status) {
                                        botMsgEl!.empty();
                                        MarkdownRenderer.renderMarkdown(json.status, botMsgEl!, '', this as any);
                                        if (json.require_confirm && json.confirm_id) {
                                            const cBox = botMsgEl!.createEl('div', { cls: 'wikicodian-confirm-box' });
                                            cBox.createEl('strong', { text: `⚠️ 高危操作拦截: ${json.action_type}` });
                                            const btnGroup = cBox.createEl('div');
                                            const btnY = btnGroup.createEl('button', { text: '允许执行', cls: 'mod-cta' });
                                            const btnN = btnGroup.createEl('button', { text: '拒绝', cls: 'mod-warning' });
                                            btnY.onclick = () => this.sendConfirm(json.confirm_id, true, cBox);
                                            btnN.onclick = () => this.sendConfirm(json.confirm_id, false, cBox);
                                        }
                                        this.messageContainer.scrollTo(0, this.messageContainer.scrollHeight);
                                    }
                                    
                                    if (json.output) {
                                        if (json.thought === '任务完成') {
                                            this.allSeenTasks.forEach(t => this.completedTasks.add(t));
                                            this.renderTasks();
                                        }
                                        fullContent += json.output;
                                        botMsgEl!.empty();
                                        MarkdownRenderer.renderMarkdown(fullContent, botMsgEl!, '', this as any);
                                        this.messageContainer.scrollTo(0, this.messageContainer.scrollHeight);
                                    }
                                } catch(e) {}
                            }
                        }
                    }
                }
            } catch (e: any) {
                window.clearInterval(timer);
                if (statusEl && statusEl.parentElement) statusEl.remove();
                if (e.name === 'AbortError') {
                    this.appendMessage('bot', `⚠️ **操作已由用户手动中断。**`);
                } else {
                    this.appendMessage('bot', `### ❌ 连接错误\n请检查后端 \`serve\` 服务。`);
                }
            } finally {
                interruptBtn.style.display = 'none';
                currentAbortController = null;
            }
        };

        this.inputEl.addEventListener('input', () => {
            const val = this.inputEl.value;
            if (val.startsWith("/")) this.showSuggest(val);
            else this.hideSuggest();
        });

        this.inputEl.addEventListener('keydown', (e) => {
            const isSuggestVisible = (this.suggestContainer as any).style.display !== 'none';
            
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
            } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        });
    }

    async sendConfirm(confirmId: string, approved: boolean, boxEl: HTMLElement) {
        boxEl.empty();
        boxEl.createEl('span', { text: approved ? "✅ 已授权执行，等待结果..." : "❌ 已拒绝执行" });
        try {
            await fetch(`${this.settings.serverUrl}/v1/confirm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirm_id: confirmId, approved })
            });
        } catch (e) {}
    }

    updateTasks(tasks: string[]) {
        let activeThisRound: string[] = [];
        for (let t of tasks) {
            let isDone = false;
            let cleanT = t;
            if (t.toLowerCase().startsWith("[x]") || t.startsWith("✅")) {
                cleanT = t.toLowerCase().startsWith("[x]") ? t.substring(3).trim() : t.substring(1).trim();
                isDone = true;
            }
            
            // 正则去重: 剥离 "1. " 或 "- " 等前缀
            cleanT = cleanT.replace(/^(\d+[\.\-、]\s*|\-\s*)/, '').trim();
            
            if (!this.allSeenTasks.includes(cleanT)) this.allSeenTasks.push(cleanT);
            
            if (isDone) this.completedTasks.add(cleanT);
            else activeThisRound.push(cleanT);
        }
        
        for (let t of this.allSeenTasks) {
            if (!activeThisRound.includes(t) && !this.completedTasks.has(t)) {
                this.completedTasks.add(t);
            }
        }
        this.renderTasks();
    }

    renderTasks() {
        if (this.allSeenTasks.length === 0) {
            (this.taskContainer as any).style.display = 'none';
            return;
        }
        (this.taskContainer as any).style.display = 'block';
        this.taskContainer.empty();
        const header = this.taskContainer.createEl('div', { cls: 'wikicodian-task-header' });
        header.createEl('strong', { text: '>> 任务清单' });
        
        const list = this.taskContainer.createEl('div', { cls: 'wikicodian-task-list' });
        for (let t of this.allSeenTasks) {
            const row = list.createEl('div', { cls: 'wikicodian-task-row' });
            if (this.completedTasks.has(t)) {
                row.createEl('span', { text: '✅', cls: 'wikicodian-task-icon-done' });
                row.createEl('span', { text: t, cls: 'wikicodian-task-text-done' });
            } else {
                row.createEl('span', { text: '⏳', cls: 'wikicodian-task-icon-active' });
                row.createEl('span', { text: t, cls: 'wikicodian-task-text-active' });
            }
        }
    }

    showSuggest(val: string) {
        this.filteredCommands = SLASH_COMMANDS.filter(c => c.name.startsWith(val.toLowerCase()));
        if (this.filteredCommands.length > 0) {
            this.suggestIndex = 0;
            this.renderSuggest();
            (this.suggestContainer as any).style.display = 'block';
        } else this.hideSuggest();
    }

    hideSuggest() { 
        (this.suggestContainer as any).style.display = 'none'; 
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

    async executeSlashCommand(cmd: string) {
        if (cmd === "/reset") {
            this.messages = [];
            this.messageContainer.empty();
            this.appendMessage('bot', "### 🔄 对话已重置");
            return;
        }
        if (cmd.startsWith("/mode ")) {
            const newMode = cmd.split(" ")[1];
            if (["auto", "plan", "wiki_only", "general_only", "build"].includes(newMode)) {
                this.chatMode = newMode;
                // 更新下拉菜单
                const sel = this.containerEl.querySelector('.wikicodian-mode-select') as HTMLSelectElement;
                if(sel) sel.value = newMode;
                
                this.appendMessage('bot', `✅ 已在前端切换模式: \`${newMode}\``);
                return;
            }
        }
        
        let backendCmd = cmd;
        if (this.currentActiveFile && this.app.vault.adapter instanceof FileSystemAdapter) {
            const p = this.app.vault.adapter.getFullPath(this.currentActiveFile.path);
            backendCmd += ` --file "${p}"`;
        }

        this.appendMessage('user', cmd);
        try {
            const res = await requestUrl({
                url: `${this.settings.serverUrl}/v1/exec`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: backendCmd })
            });
            if (res.status === 200) {
                const output = res.json.output || "执行成功";
                this.appendMessage('bot', output);

                // --- 自动打开生成的文件 ---
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

    async openExternalOrLocalFile(absPath: string) {
        const adapter = this.app.vault.adapter as any;
        const vaultPath = (adapter.basePath || "").replace(/\\/g, '/');
        const normalizedAbs = absPath.replace(/\\/g, '/');
        
        if (normalizedAbs.startsWith(vaultPath)) {
            const relativePath = normalizedAbs.slice(vaultPath.length).replace(/^\//, '');
            const file = this.app.vault.getAbstractFileByPath(relativePath);
            if (file instanceof TFile) {
                this.app.workspace.getLeaf(true).openFile(file);
                new Notice(`已打开文件: ${file.name}`);
            }
        } else {
            if ((window as any).electron) {
                (window as any).electron.remote.shell.openPath(absPath);
            }
        }
    }

    appendMessage(role: string, text: string) {
        const cleanText = text.split('\n').filter(l => !l.startsWith("FILE_PATH:")).join('\n');
        const msgEl = this.messageContainer.createEl('div', { cls: `wikicodian-message wikicodian-message-${role}` });
        if (role === 'user') msgEl.setText(cleanText);
        else MarkdownRenderer.renderMarkdown(cleanText, msgEl, '', this as any);
        this.messageContainer.scrollTo(0, this.messageContainer.scrollHeight);
        return msgEl;
    }
}

export default class WikicodianPlugin extends Plugin {
    settings: WikicodianSettings;

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

    async runCanvasConversion(useAi: boolean) {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') {
            new Notice("请先打开一个 Markdown 文件");
            return;
        }

        const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_WIKICODIAN)[0]?.view as WikicodianView;
        if (!view) {
            await this.activateView();
        }
        
        const cmd = useAi ? `/md2canvas_ai ${activeFile.path}` : `/md2canvas ${activeFile.path}`;
        const finalView = this.app.workspace.getLeavesOfType(VIEW_TYPE_WIKICODIAN)[0]?.view as WikicodianView;
        if (finalView) {
            finalView.executeSlashCommand(cmd);
        }
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

class WikicodianSettingTab extends PluginSettingTab {
    plugin: WikicodianPlugin;
    constructor(app: any, plugin: WikicodianPlugin) { super(app, plugin); this.plugin = plugin; }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        new Setting(containerEl).setName('Backend URL').addText(text => text.setValue(this.plugin.settings.serverUrl).onChange(async (v) => {
            this.plugin.settings.serverUrl = v;
            await this.plugin.saveSettings();
        }));
    }
}
