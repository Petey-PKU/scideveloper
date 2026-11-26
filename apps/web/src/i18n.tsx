import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Locale = 'zh' | 'en';

const dict = {
  en: {
    brand: 'SciDeveloper',
    newResearch: 'New Research',
    sessions: 'Chats',
    files: 'Files',
    memory: 'Memory',
    papers: 'Papers',
    recentResearch: 'Recent Research',
    searchSessions: 'Search chats, genes, results…',
    settingsAndAdvanced: 'Settings',
    commandPaletteHint: 'Ctrl+K',
    results: 'Results',
    methods: 'Methods',
    quality: 'Quality',
    manuscript: 'Manuscript',
    kernel: 'Kernel',
    hideResults: 'Hide results',
    showResults: 'Results',
    liveDb: 'Live DB',
    offlineDb: 'Cached DB',
    configureModel: 'Configure Model',
    modelNotConfiguredTitle: 'Connect an AI Model to Get Started',
    modelNotConfiguredDesc:
      'Connect Anthropic Claude, OpenAI, Google Gemini, DeepSeek, OpenRouter, Qwen, Ollama, or any compatible endpoint. API keys are encrypted locally on your device.',
    openModelSettings: 'Open Model Settings',
    askPlaceholder: 'Ask a research question, or drop CSV / XLSX / PDF / PDB files here…',
    sendHint: 'Enter to send · Shift+Enter for new line · Drop files to attach',
    specialist: 'Mode',
    autoRoute: 'Auto',
    stopRun: 'Stop',
    steerPlaceholder: 'Guide this run… e.g. "Use FDR < 0.01 and add a volcano plot"',
    sendSteer: 'Send',
    thinking: 'Reasoning',
    liveOutput: 'Live Output',
    compactContext: 'Compact',
    compacting: 'Compacting…',
    dagGraph: 'Branches',
    compareMode: 'Compare',
    exitCompare: 'Exit Compare',
    fullscreen: 'Fullscreen',
    exitFullscreen: 'Close Fullscreen',
    editAndBranch: 'Edit & Branch',
    rename: 'Rename',
    pin: 'Pin',
    unpin: 'Unpin',
    deleteSession: 'Delete',
    confirmDelete: 'Delete this research chat and all its generated results?',
    exportFilteredCsv: 'Export CSV',
    sortAsc: 'Sorted ascending',
    sortDesc: 'Sorted descending',
    runCell: 'Run Cell',
    editCode: 'Edit & Run',
    restartKernel: 'Restart Kernel',
    variables: 'Variables',
    noVariables: 'No active variables yet. Run a Python or R cell to inspect DataFrames and arrays.',
    saveMemory: 'Add Note',
    uploadPaper: 'Import PDF',
    searchPapers: 'Search across imported papers…',
    starterHeadline: 'What would you like to investigate?',
    starterSubtitle:
      'Ask a question in plain language or drop in local data and papers. SciDeveloper runs the analysis, builds interactive figures, and verifies every claim.',
    approvalNeeded: 'Approval needed',
    noSessionsFound: 'No matching chats found.',
    citationVerified: 'Verified Citation',
    citationUnverified: 'Unverified Citation',
    viewPubMed: 'Open Source',
    viewAudit: 'View Quality Report',
    quickActions: 'Quick Actions',
    switchLang: 'Switch Language (中文 / EN)',
    toggleTheme: 'Toggle Light / Dark Theme',
    projects: 'Projects',
    allChats: 'All Chats',
    researchProject: 'Project',
    newProject: 'New Project',
    editProject: 'Edit Project',
    createProject: 'Create Project',
    saveProject: 'Save Project',
    deleteProject: 'Delete Project',
    confirmDeleteProject: 'Delete this project? Conversations inside it will remain available as standalone chats.',
    projectModalSubtitle: 'Organize related chats, shared instructions, workspace files, notes, and papers under one topic',
    projectName: 'Project Name',
    projectDescription: 'Brief Summary / Goal',
    projectColor: 'Accent Color',
    projectInstructions: 'Shared Instructions (SOP)',
    projectWorkspace: 'Workspace Folder',
    projectCompute: 'Compute Environment',
    projectDefaultSkills: 'Default Research Protocols',
    projectOverview: 'Project Overview',
    projectConversations: 'Conversations',
    projectChatsUnit: 'chats',
    projectRecentResults: 'Recent Results',
    projectSharedKnowledge: 'Shared Knowledge',
    startChatInProject: 'Ask a question in',
    newChatInProject: 'New Chat in Project',
    projectInheritsHint: "Automatically uses this project's instructions, files, notes & papers",
    noProjectChatsYet: 'No conversations in this project yet. Ask your first question above to start!',
    noProjectInstructions: 'No shared instructions yet. Add reference genome, statistical thresholds, or cohort details so every chat stays consistent.',
    moveToProject: 'Move to Project',
    standaloneChats: 'Standalone Chats',
    noProjectAssigned: 'No Project (Standalone)',
  },
  zh: {
    brand: 'SciDeveloper',
    newResearch: '新建对话',
    sessions: '会话',
    files: '文件',
    memory: '记忆',
    papers: '文献',
    recentResearch: '最近对话',
    searchSessions: '搜索对话、基因名、图表结果…',
    settingsAndAdvanced: '设置',
    commandPaletteHint: 'Ctrl+K',
    results: '结果',
    methods: '方法与代码',
    quality: '质量审查',
    manuscript: '论文手稿',
    kernel: '代码内核',
    hideResults: '收起结果',
    showResults: '结果',
    liveDb: '在线数据库',
    offlineDb: '本地缓存',
    configureModel: '配置模型',
    modelNotConfiguredTitle: '连接 AI 模型即可开始科研分析',
    modelNotConfiguredDesc:
      '支持 Anthropic Claude、OpenAI、Google Gemini、DeepSeek、OpenRouter、通义千问、智谱 GLM、Kimi、Ollama 等主流模型。API Key 仅在本机加密保存。',
    openModelSettings: '前往配置模型',
    askPlaceholder: '输入科研问题，或直接拖入 CSV / XLSX / PDF / PDB 数据文件…',
    sendHint: 'Enter 发送 · Shift+Enter 换行 · 支持拖拽上传文件',
    specialist: '模式',
    autoRoute: '自动',
    stopRun: '停止',
    steerPlaceholder: '运行中补充要求… 例如「改用 FDR < 0.01 并绘制交互火山图」',
    sendSteer: '发送',
    thinking: '思考过程',
    liveOutput: '运行输出',
    compactContext: '压缩上下文',
    compacting: '压缩中…',
    dagGraph: '分支图谱',
    compareMode: '并排对比',
    exitCompare: '退出对比',
    fullscreen: '全屏查看',
    exitFullscreen: '退出全屏',
    editAndBranch: '编辑并分叉',
    rename: '重命名',
    pin: '置顶',
    unpin: '取消置顶',
    deleteSession: '删除',
    confirmDelete: '确定删除该对话及其所有生成结果吗？',
    exportFilteredCsv: '导出 CSV',
    sortAsc: '已升序排列',
    sortDesc: '已降序排列',
    runCell: '运行代码',
    editCode: '编辑并运行',
    restartKernel: '重启内核',
    variables: '内核变量',
    noVariables: '当前内核暂无变量，运行 Python 或 R 代码后可在此查看数据表与矩阵。',
    saveMemory: '新增记忆',
    uploadPaper: '导入 PDF',
    searchPapers: '检索已导入文献全文…',
    starterHeadline: '今天想研究什么课题？',
    starterSubtitle:
      '用自然语言提问，或直接拖入本地实验数据与论文。SciDeveloper 会自动完成分析计算、绘制交互图表并核验文献引用。',
    approvalNeeded: '等待确认',
    noSessionsFound: '未找到匹配的对话。',
    citationVerified: '已核验引用',
    citationUnverified: '未核验引用',
    viewPubMed: '打开原文链接',
    viewAudit: '查看质检报告',
    quickActions: '快捷操作',
    switchLang: '切换语言（中文 / EN）',
    toggleTheme: '切换浅色 / 深色外观',
    projects: '研究项目',
    allChats: '全部对话',
    researchProject: '项目',
    newProject: '新建项目',
    editProject: '编辑项目',
    createProject: '创建项目',
    saveProject: '保存项目',
    deleteProject: '删除项目',
    confirmDeleteProject: '确定删除该项目吗？项目内的历史对话将保留为独立对话，不会丢失。',
    projectModalSubtitle: '按课题统一管理相关对话、共享科研要求、数据文件夹、实验记忆与文献库',
    projectName: '项目名称',
    projectDescription: '课题简介 / 研究目标',
    projectColor: '标识颜色',
    projectInstructions: '项目共享要求（SOP）',
    projectWorkspace: '项目数据目录',
    projectCompute: '计算环境',
    projectDefaultSkills: '默认科研协议',
    projectOverview: '项目主页',
    projectConversations: '项目对话',
    projectChatsUnit: '个对话',
    projectRecentResults: '近期成果',
    projectSharedKnowledge: '共享知识库',
    startChatInProject: '在项目中提问：',
    newChatInProject: '新建项目对话',
    projectInheritsHint: '自动沿用该项目的共享要求、数据目录、记忆与文献库',
    noProjectChatsYet: '该项目下还没有对话，在上方输入第一个问题即可开始！',
    noProjectInstructions: '尚未填写共享要求。可记录参考基因组、统计阈值或样本说明，让项目内所有对话保持一致标准。',
    moveToProject: '移动到项目',
    standaloneChats: '独立对话',
    noProjectAssigned: '未归属项目（独立对话）',
  },
} as const;

export type I18nKey = keyof typeof dict.en;

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: I18nKey) => string;
  L: (zh: string, en: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'zh',
  setLocale: () => {},
  t: (key) => dict.zh[key],
  L: (zh) => zh,
});

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const stored = localStorage.getItem('scideveloper.locale');
    if (stored === 'zh' || stored === 'en') return stored;
    return initialLocale ?? (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');
  });

  useEffect(() => {
    if (initialLocale && !localStorage.getItem('scideveloper.locale')) {
      setLocaleState(initialLocale);
    }
  }, [initialLocale]);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  function setLocale(next: Locale) {
    setLocaleState(next);
    localStorage.setItem('scideveloper.locale', next);
  }

  return (
    <I18nContext.Provider
      value={{
        locale,
        setLocale,
        t: (key) => dict[locale][key] ?? dict.en[key],
        L: (zh, en) => (locale === 'zh' ? zh : en),
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
