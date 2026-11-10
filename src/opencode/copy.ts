export const copy = {
  en: {
    headsUp: "Heads up",
    explainer: "You should know",
    known: "I knew this",
    understood: "Understood",
    dismiss: "Dismiss",
    discuss: "Discuss in chat",
    evidence: "Based on",
    empty: "Nothing needs your attention.",
    notes: "You Should Know · Notes",
    unavailable: "Could not load notes. Try again in a moment.",
    discussing:
      "You Should Know noticed this. Help me understand the tradeoff and decide what to do:",
    saved: "Saved",
    more: "Learn more",
    pause: "Pause suggestions",
    resume: "Resume suggestions",
  },
  ru: {
    headsUp: "Обрати внимание",
    explainer: "Стоит знать",
    known: "Я это знаю",
    understood: "Понятно",
    dismiss: "Скрыть",
    discuss: "Обсудить в чате",
    evidence: "На основании",
    empty: "Сейчас нет важных замечаний.",
    notes: "You Should Know · Заметки",
    unavailable: "Не удалось загрузить заметки. Попробуй чуть позже.",
    discussing:
      "You Should Know заметил следующее. Помоги разобраться в последствиях и принять решение:",
    saved: "Сохранено",
    more: "Подробнее",
    pause: "Приостановить подсказки",
    resume: "Возобновить подсказки",
  },
  zh: {
    headsUp: "请留意",
    explainer: "值得了解",
    known: "我已了解",
    understood: "明白了",
    dismiss: "关闭",
    discuss: "在对话中讨论",
    evidence: "依据",
    empty: "目前没有需要留意的事项。",
    notes: "You Should Know · 提示",
    unavailable: "暂时无法加载提示，请稍后重试。",
    discussing: "You Should Know 注意到了以下问题。请帮我理解其中的取舍，并决定下一步：",
    saved: "已保存",
    more: "了解更多",
    pause: "暂停提示",
    resume: "恢复提示",
  },
} as const

export type Language = keyof typeof copy
export function languageOf(value: unknown, fallback?: string): Language {
  const language = typeof value !== "string" || value === "auto" ? fallback : value
  return language?.startsWith("ru") ? "ru" : language?.startsWith("zh") ? "zh" : "en"
}
