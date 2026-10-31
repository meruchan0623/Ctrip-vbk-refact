# Windows 接续环境重核

日期：2026-10-31，Asia/Shanghai。任务0与第5轮准备证据，不是第5轮新包验收。原完整轮数仍为4/6。

## 源码与工具

初始目录 `C:\Develop\Ctrip-vbk-refact` 是干净的 `main/f61a0bf4caa5f44e24416512c23e16a0ed0edcef`，没有交接文档。只读核对远端后切换 `feat/prototype-restore-macos`；本地与远端均为交接 `66b876907f0fa7bf75f00fcdfb3aa863aef80f99`，未覆盖既有修改。后续仅本地提交，未推送。

- Node 24.13.0、npm 11.6.2、rustc/cargo 1.95.0；默认目标 `x86_64-pc-windows-msvc`。
- VS2022 BuildTools 在 `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`，vswhere确认C++组件；核心及宿主测试实际链接成功。WebView2注册版本156.0.4314.58。
- 初次 `npm install` 退出0，typecheck因缺tsc退出1。98311bf锁定TypeScript6.0.3、Node types22.20.5、Tauri CLI2.12.4；独立暂存快照npm ci/typecheck/bundle/CLI检查均退出0。
- 交接基线TS483/核心Rust301，零失败/跳过。Windows宿主基线比Mac少1项：`keychain.rs::tests::only_explicit_not_found_means_missing_marker`原本限`cfg(all(test,target_os="macos"))`，没有删除或ignored；不能把条件编译差异算成新增测试通过。后续新增测试及冻结包另记。

Windows源码分块：1a32e8d译文请求实例、e21a6e9身份补全分页锚点、a3fbb22严格持久化已完成独立暂存验证和独立Sol/xhigh复审。UI总数493；核心304；Windows宿主115（基线114+跨进程重启1项），0失败/跳过。文件/目录同步的OS5已修复，真实共享句柄拒绝仍阻止出站；不代表硬件断电测试。第5轮冻结a3fbb22，dirty=[]，manifest SHA256 `07596ea75643c053b6937551961fd5ddb5f158c829fdf135cf62f858eb675c17`，独立源码位于 `%TEMP%\vbk-windows-20261031\round5-source`。首次全新宿主编译因frontendDist不存在退出101，补bundle后续跑；最终构建/运行另记。

## 官方桌面与已安装助手（只读）

官方实际进程 `C:\Program Files\vbk-electron\旅游商家桌面版.exe`，发现时主PID23400，文件版本1.2.12.2679625，SHA256 `4fad3f96a67067aea50c355fe138f96c33c71deea4da17c19ee81b5a206cc6c4`。原生窗口可读，Mac的-1712不适用于本次Windows结果。

助手实际进程 `C:\Program Files\vbk-electron\resources\TripVendorCompanion\旅游商家助手.exe`，发现时PID6324/21736/18112，SHA256 `bb9cf9ae673e51079c721fba7eed74b94d9fc33194fb0101c29431a7c99e8c89`。安装回执manifest.version=0.5.41；exe资源版本44.7.2不能当成助手业务版本。未注入、重装或修改官方/助手文件。

按授权订单搜索，结果匹配指定客户；只读会话历史能看到旧测试标记，随后回到该受控会话。标题客户、消息订单卡、右侧订单对应；真实侧栏iframe URL含groupid/sessionid/uid，已现场读取真实room身份。原值只留本机临时AX证据，不把别名当gid，没有新发消息。

本人名称、接口头像、三人成员标题、本人消息右侧、旧测试消息未读、来源渠道/订单/使用日期/总额已见。助手翻译栏、订单查询入口实际挂载；套餐速览有有效套餐数据及“刚刚更新”。仅证明该样本查询界面有数据，不能沿用Mac认证失败判定本机失败；在线翻译、完整接口鉴权与所有权限尚未验收。

原始AX与截图：`%TEMP%\vbk-windows-20261031\official-assistant.ax.txt`、`official-assistant-0.png`（原始JPEG编码）。图像SHA256 `4b556452beb59e27af6eb911203181260cceec47000f75bea3f34820208330df`。文件含业务数据，只临时保管，不进Git。

媒体静态核对：本机官方dist `index-CpM_cEEe.js` SHA256 `791902faae01b3aa66dc57f1523cf34717f0e81b78f13b0cbd2865969cc837f6` 与 `imWindow-C3Pt24cG.js` SHA256 `c4fedb4f97bb8755946c326e228b947b8078dd91e994fde3e76ddc2180737f35`，pkg1.2.12/ares1.2.17；图片channel/scene与历史44网络证据一致。静态门禁图片10MiB、文件30MiB、视频300MiB/3分钟；视频直传阈值30MiB、分片5MiB。这不是本轮真实上传、网络请求或上游强制上限的验证；第6轮若采用更低本地资源保护上限必须单独明示。

## 网页与自制客户端

本轮目标允许已有浏览器替代ego。用本机Edge扩展创建唯一专用页面“🔎 VBooking验收”，保留其它用户页面。指定URL转到登录页；官方“桌面客户端授权登录”显示“唤起客户端失败，请前往安装并运行旅游商家桌面版”。实际官方进程在运行，不能据提示推断未安装。已请求用户正常登录，未复制Cookie、密码或Mac钥匙串。

任务0时自制Windows新包尚未构建启动。后续[第5轮记录](2026-10-31-round5-windows-runtime.md)已核实a3fbb22包与PID14828，欢迎页及官方登录窗可见，仍待正常账号登录。官方原生gid不能替代新包与网页当轮双核。C/W双向、自然实时、媒体、引用撤回、客户端精确滚动、切账号及客户已读均未通过本轮验收。

## TSim只读源码

本机 `C:\Develop\TSim_CS_Full_Automation`，HEAD `459e41878a6aecbc7a36e7d157db3784d1d47b73`，检查时工作树干净。重读KKday dispatcher/reconciler、respond.io入站、发送路由/client及回执核验候选；精确边界见[接入说明](../integration/tsim-cs.md)。未修改、运行服务或部署TSim。

根目录离线示例 `node --experimental-strip-types tools/contracts/run-vbooking-contract-demo.mts` 退出0：confirmed/rejected/missing_ack/unsafe_id/disposed/read_callback六场景通过，明确implemented_in_tsim=false。这是合成adapter示例，不是整体接入或实发验收。
