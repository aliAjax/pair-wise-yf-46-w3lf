import i18n from "i18next";
import { initReactI18next } from "react-i18next";

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: { title: "新闻直播编排台", rundown: "串联单", conflicts: "并发冲突", changes: "突发变更", queue: "应急队列", audit: "审计留档" } },
    en: { translation: { title: "News Rundown Control", rundown: "Rundown", conflicts: "Conflicts", changes: "Breaking changes", queue: "Emergency queue", audit: "Audit trail" } }
  },
  lng: "zh",
  fallbackLng: "zh",
  interpolation: { escapeValue: false }
});

export default i18n;
