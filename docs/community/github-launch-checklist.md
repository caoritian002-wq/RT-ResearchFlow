# GitHub 首发配置清单

本清单供仓库维护者执行。README 不属于本轮修改范围；所有页面文案、截图和 Release 说明必须只描述公开仓库真实拥有的能力。

## 1. 推送仓库侧配置

- [ ] 确认 `./.github/scripts/Test-PublicBoundary.ps1` 通过。
- [ ] 确认 `pnpm run verify` 通过。
- [ ] Review 待提交文件，确认没有数据库、日志、凭据、持仓、本机路径和构建产物。
- [ ] 将仓库侧配置推送到 `main`，等待 `Verify / verify` 首次成功运行。

## 2. Topics

在仓库主页 **About -> Settings** 中添加以下 12 个 Topics：

```text
a-share
china-stock-market
investment-research
financial-research
local-first
electron
typescript
sqlite
ai-agent
deep-research
portfolio-analysis
backtesting
```

不要添加 `trading-bot`、`stock-prediction` 或 `auto-trading`，避免吸引与产品边界不符的用户。

## 3. Discussions

- [ ] 在 **Settings -> General -> Features** 开启 Discussions。
- [ ] 只保留或创建 `Announcements`、`Q&A`、`Ideas`、`Show and tell` 四个分类。
- [ ] `Announcements` 设置为仅维护者可创建。
- [ ] 根据 `docs/community/discussion-launch.md` 发布三篇首发内容。
- [ ] 置顶《欢迎来到 RT-ResearchFlow》《社区版能力与项目边界》《v0.1.0-beta.1 使用反馈集中帖》三篇讨论。
- [ ] 验证 Issue 模板中的 Q&A 与 Ideas 链接能够打开对应分类。

## 4. 安全设置

在 **Settings -> Security** 或 **Security -> Security advisories** 中确认：

- [ ] Private vulnerability reporting 已开启，外部用户可以看到 **Report a vulnerability**。
- [ ] Secret scanning 已开启。
- [ ] Push protection 已开启。
- [ ] Dependency graph 和 Dependabot alerts 已开启。
- [ ] `SECURITY.md` 中的私密报告路径实际可用。

不要要求报告者通过公开 Issue 提交漏洞、凭据样本或数据库。

## 5. main 规则集

在 **Settings -> Rules -> Rulesets** 新建轻量规则集 `main-protection`：

- [ ] 目标分支为默认分支 `main`，规则集状态为 Active。
- [ ] 阻止分支删除和 force push。
- [ ] 要求状态检查 `Verify / verify` 成功。
- [ ] 不允许通过关闭检查、改名工作流或管理员随意绕过来发布失败代码。
- [ ] 当前个人维护阶段不强制多名审批者；引入稳定协作者后再增加 Pull Request 审批要求。

如果 GitHub 尚未列出 `Verify / verify`，先让 `main` 或测试 Pull Request 成功运行一次 Verify 工作流，再回来配置规则集。

## 6. Draft Prerelease

仓库侧配置和线上设置完成后创建并推送标签：

```powershell
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

`Release` 工作流应依次完成版本校验、公开边界、完整 Verify、Windows x64 打包、SHA256、真实解包应用冒烟测试，并创建 Draft Prerelease。检查：

- [ ] 工作流没有使用真实 AI、Tushare 或搜索凭据。
- [ ] Draft 中只有 `RT-ResearchFlow-Setup-0.1.0-beta.1-x64.exe` 和 `SHA256SUMS.txt`。
- [ ] Release 标记为 Draft 和 Prerelease，没有自动公开。
- [ ] Release notes 与 `docs/releases/v0.1.0-beta.1.md` 一致。

## 7. 干净机与公开

- [ ] 下载 Draft 产物，不使用本地 `release` 目录中的副本。
- [ ] 完整执行 `docs/releases/windows-clean-machine-checklist.md`。
- [ ] 将测试机器、安装包 SHA256、时间、结果和失败 Issue 记录到 Release 验收记录。
- [ ] 所有阻断项清零后手动发布 Prerelease。
- [ ] 从未登录 GitHub 的浏览器复查“发现 -> 理解 -> 下载 -> 反馈”路径。

首发完成标准不是 Star 数量，而是陌生用户能够理解项目边界、下载可信安装包、完成零 Key 首次体验，并找到正确的反馈入口。
