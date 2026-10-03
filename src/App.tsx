import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { Button, message, notification, Select, Switch, Tag } from "antd";
import { RundownPage } from "./pages/RundownPage";
import { QueuePage } from "./pages/QueuePage";
import { ChangesPage } from "./pages/ChangesPage";
import { LedgerPage } from "./pages/LedgerPage";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { dismissLegacy, dismissToast, persistLedger, replayQueue, setOnline, setRole } from "./store/ledgerSlice";
import type { Role } from "./types";

export default function App() {
  const dispatch = useAppDispatch();
  const { online, role, outbox, conflicts, lastToast, legacyNotice } = useAppSelector((s) => s.ledger);
  const { t, i18n } = useTranslation();
  const [messageApi, contextHolder] = message.useMessage();
  const [notificationApi, notificationContextHolder] = notification.useNotification();

  const pendingCount = outbox.filter((o) => o.status !== "written").length;
  const openConflicts = conflicts.filter((c) => !c.resolved).length;

  // 持久化账本到本地
  useEffect(() => {
    dispatch(persistLedger());
  });

  // 离线 -> 在线：自动按操作序号合并应急队列
  const prevOnline = useRef(online);
  useEffect(() => {
    if (!prevOnline.current && online) {
      if (outbox.some((o) => o.status !== "written")) dispatch(replayQueue(false));
    }
    prevOnline.current = online;
  }, [online, outbox, dispatch]);

  // 全局提示
  useEffect(() => {
    if (lastToast) {
      const key = lastToast.kind === "info" ? "info" : lastToast.kind;
      messageApi[key](lastToast.message);
      dispatch(dismissToast());
    }
  }, [lastToast, messageApi, dispatch]);

  // 旧数据迁移提示
  useEffect(() => {
    if (legacyNotice) {
      notificationApi.info({ message: "旧版数据已补版本号", description: legacyNotice, duration: 9 });
      dispatch(dismissLegacy());
    }
  }, [legacyNotice, notificationApi, dispatch]);

  return (
    <div className="app-shell">
      {contextHolder}
      {notificationContextHolder}
      <aside className="sidebar">
        <div className="brand">
          <span>LIVE</span>
          <div>
            <b>{t("title")}</b>
            <small>Control room</small>
          </div>
        </div>
        <nav>
          <NavLink to="/">{t("rundown")}</NavLink>
          <NavLink to="/changes">{t("changes")}</NavLink>
          <NavLink to="/queue">
            {t("queue")}
            {pendingCount ? <em>{pendingCount}</em> : null}
          </NavLink>
          <NavLink to="/ledger">
            {t("ledger")}
            {openConflicts ? <em className="conflict-badge">{openConflicts}</em> : null}
          </NavLink>
        </nav>
        <Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>
          {i18n.language === "zh" ? "EN" : "中文"}
        </Button>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <small>直播运行中 · 紧急操作均保留审计与版本记录</small>
            <h1>{t("title")}</h1>
          </div>
          <div className="top-actions">
            <label>
              在线模式
              <Switch checked={online} onChange={(value) => dispatch(setOnline(value))} />
            </label>
            <label>
              当前岗位
              <Select<Role>
                value={role}
                onChange={(value) => dispatch(setRole(value))}
                options={[{ value: "导播" }, { value: "主编" }, { value: "字幕" }, { value: "演播室" }]}
              />
            </label>
            <Tag color={online ? "green" : "red"}>{online ? "链路正常" : "应急队列"}</Tag>
          </div>
        </header>
        <Routes>
          <Route path="/" element={<RundownPage />} />
          <Route path="/changes" element={<ChangesPage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/ledger" element={<LedgerPage />} />
        </Routes>
      </main>
    </div>
  );
}
