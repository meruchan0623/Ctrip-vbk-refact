# 05 原生层、签名、打包与更新链路（rea 静态检查）

> 对象：Mac 1.2.13（/Applications/旅游商家桌面版.app）、Windows 1.2.12（~/Downloads/vbk-electron/）。全部为静态 inspect-*，不执行目标文件。

## 1. 概述

- **原生文件数量**：Mac 有 7 个非框架原生文件（5 个 Mach-O x86_64，其中 captureTool 在 plugin/，4 个在 asar.unpacked；另有 2 个 Linux ELF 死文件），加上 Frameworks 里 4 个 Framework、4 个 Helper、ShipIt、crashpad。Windows 检查了 17 个 PE（官方 11 个，插件 6 个），Companion 下另有 dxil、d3dcompiler、vulkan、PenImc 等运行时 DLL。
- **签名**：Mac 整包是 Developer ID（携程 F63Y***）签名，开启 Hardened Runtime，已公证并装订，deep strict 校验通过，**没有插件痕迹**；但 entitlements 同时开了 disable-library-validation 和 allow-dyld-environment-variables。Windows 官方包**完全没有 Authenticode 签名**，插件文件也都没有签名（只有插件带的 .NET wpfgfx 有微软签名）。
- **fuses**：Mac、Win 官方包完全一致，都是出厂默认（RunAsNode、NodeOptions、--inspect 开启，asar 完整性关闭）；插件 Companion（Electron 44.7.2）也是默认值。
- **更新链路**：整包更新走 electron-updater（generic，feedUrl 由远端 JSON 下发，有 sha512；Mac 另有 Squirrel 签名校验）。**渲染层热更新 dist.zip 被强制降级为 HTTP，不做任何校验就用 adm-zip 覆盖解压**（P0，即 03 的 SUP-01），解压不经过 7za。
- **4 个完整性不符文件**：都是 electron-builder 先写 asar header、后对 unpacked Mach-O 执行 codesign 造成的元数据过期（**官方构建问题，不是插件**）。Windows 没有签名步骤，781 个 unpacked 文件全部一致，可以作为反证。
- **体积**：官方 Mac 744 MB，node_modules 639 MB，113 个包存在多版本；自研 Tauri 17–19 MB，但只有 adhoc 签名、没有 updater。

## 2. Mac 原生清单与签名

### 2.1 Info.plist（inspect-plist，官方）

| 键 | 值 | 评价 |
|---|---|---|
| CFBundleIdentifier / 版本 | com.ctrip.vbooking / 1.2.13（Build 1.2.13.2712559） | — |
| LSMinimumSystemVersion | 10.15 | 与主程序 LC_BUILD_VERSION minos 10.15 一致 |
| DTSDKName / DTXcode | macosx13.3 / 1431 | Electron 27 官方预编译产物 |
| NSAppTransportSecurity.NSAllowsArbitraryLoads | **true**（另有 NSAllowsLocalNetworking=true，localhost/127.0.0.1 允许 HTTP） | 全局关闭 ATS |
| NSCameraUsageDescription / NSMicrophoneUsageDescription | 均为 Electron 模板英文文案 "This app needs access to the camera/microphone" | 未本地化，未说明用途 |
| NSBluetoothAlwaysUsageDescription / PeripheralUsageDescription | 模板英文文案 | 业务上没有蓝牙需求，属于模板残留 |
| CFBundleURLTypes | scheme `vbookingChat`（Role=Editor） | 深链入口，需要在主进程校验参数 |
| ElectronAsarIntegrity | Resources/app.asar SHA256 `3a26***` | 我们重算 asar header 的 SHA256 为 `3a26***`，**一致** |
| LSApplicationCategoryType | public.app-category.developer-tools | 分类填错（应为 business/productivity） |
| LSEnvironment | MallocNanoZone=0 | Electron 默认 |

### 2.2 代码签名与公证（inspect-signature + codesign/spctl/stapler 只读校验）

- 签名身份：`Developer ID Application: Xiecheng Tourism Network Technology (Shanghai) Co., Ltd. (F63Y***)`，证书链 Developer ID CA → Apple Root CA；时间戳 2026-10-30 13:38–13:39。
- Hardened Runtime：**开启**。但 entitlements 4 项全开：`allow-jit`、`allow-unsigned-executable-memory`、`allow-dyld-environment-variables`、`disable-library-validation`。后两项让 Hardened Runtime 基本失去防注入意义（可用 DYLD_INSERT_LIBRARIES 注入、可加载任意团队签名的 dylib）。
- 所有被检查的 Mach-O 都使用同一套 entitlements（主程序、Electron Framework、Squirrel、ShipIt、4 个 Helper、captureTool、4 个 unpacked 原生文件），说明 electron-builder 对所有可执行文件统一套用了主程序 entitlements，没有按最小权限给 Helper/工具单独配置。
- `codesign --verify --deep --strict`：**valid on disk / satisfies its Designated Requirement**。
- `spctl -a -t exec`：**accepted，source=Notarized Developer ID**；`stapler validate`：**通过（已装订公证票据）**。
- 结论：Mac 安装包签名封印完整，**未被插件改动**（插件若改 Resources 任何文件，deep strict 校验会失败）。Resources 下没有 TripVendorLauncher、companion 或任何 TripVendor* 文件（`find -iname '*TripVendor*' -o -iname '*companion*'` 无结果）。安装包内插件痕迹为零，这和 Windows 版不同；系统里只残留 TripVendorLauncher 崩溃记录和 DevToolsActivePort，属于历史痕迹（03 的 PLG-04，复核一致）。

### 2.3 架构（inspect-macho）

| 文件 | 架构 | minos / SDK | 签名 |
|---|---|---|---|
| MacOS/旅游商家桌面版 | 仅 x86_64（architectures.total=1） | 10.15 / 13.3（LLD 17） | 官方 F63Y*** |
| Electron Framework | 仅 x86_64 | — / 13.3 | 官方 |
| Squirrel / ShipIt | 仅 x86_64 | — / 13.3 | 官方 |
| Helper / GPU / Plugin / Renderer | 仅 x86_64 | — / 13.3 | 官方 |

在 Apple Silicon 上整包都要经过 Rosetta 2 运行。主进程 split 文本里有 `archGuideTitle / archGuideDescIntel / archGuideDescApple` 文案键，说明官方知道有 Intel/Apple 两种机型，但这个包只提供 Intel 版本。

### 2.4 原生文件清单（Resources 下，排除 Frameworks）

| # | 路径（相对 Resources） | 类型 | 字节 | 权限 | 签名 | 依赖 |
|---|---|---|---|---|---|---|
| 1 | plugin/captureTool | Mach-O exe x86_64，minos SDK 12.3 | 70,480 | rw-r--r--（无 x 位） | 官方 F63Y***，HR | 6 个系统库 |
| 2 | app.asar.unpacked/node_modules/node-screenshots-darwin-x64/node-screenshots.darwin-x64.node | Mach-O dylib x86_64，SDK 15.5 | 738,080 | rw-r--r-- | 官方 | 19 个系统库；LC_ID_DYLIB 残留 CI 路径 `/Users/runner/work/node-screenshots/...` |
| 3 | app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.17.3.dylib | Mach-O dylib x86_64，SDK 15.5 | 18,150,048 | rw-r--r-- | 官方 | 11 个系统库；ID=@rpath/libvips-cpp.8.17.3.dylib |
| 4 | app.asar.unpacked/node_modules/@ctrip/node-vampire-dal/bin/DalDecrypt_mac | Mach-O exe x86_64，SDK 10.13 | 28,432 | rw-r--r--（无 x 位） | 官方 | 1 个系统库 |
| 5 | app.asar.unpacked/node_modules/@ctrip/node-vampire-p7zip/bin/darwin/7za | Mach-O exe x86_64，SDK 10.12 | 1,667,968 | rwxr-xr-x | 官方 | 3 个系统库 |
| 6 | …/node-vampire-dal/bin/DalDecrypt_linux | ELF x86-64 | 13,162 | — | 无（Linux） | Mac 包里的死文件 |
| 7 | …/node-vampire-p7zip/bin/linux/7za | ELF x86-64 | 1,143,256 | — | 无 | Mac 包里的死文件 |

补充：Mac 包里有 `@img/sharp-libvips-darwin-x64`，但 **没有 `@img/sharp-darwin-x64` 的 `.node` 绑定**（unpacked 下找不到 sharp-*.node）。渲染层 OCR 代码 `e("sharp")` 在 Mac 上大概率会走 catch 分支，属于官方打包遗漏（待运行时确认）。DalDecrypt_mac、captureTool 没有执行位，如果直接 spawn 会报 EACCES，除非调用方先 chmod。

### 2.5 dyld 解析（trace-dylib-resolution，整个 app）

- 自动发现 10 个根：crashpad_handler、ShipIt、4 个 Helper、主程序、DalDecrypt_mac、7za、captureTool。共 489 条加载边：37 条 resolved（全部是 @rpath 指向包内 Framework/libffmpeg），452 条 undetermined（全部是 /System、/usr/lib 绝对路径，按设计不在分析范围内）。
- 没有指向 /usr/local、/opt/homebrew、用户目录的非系统绝对路径，也没有缺失的依赖。
- 17 条 `earlier-rpath-candidate-absent` 发现（Electron Framework 15 条、ShipIt 2 条）：dyld 会先探测 `…/Resources/../../Mantle.framework` 等更靠前的 rpath 候选位置，这些位置当前不存在。结合 `disable-library-validation` + `allow-dyld-environment-variables`，**如果有人能写入 .app 目录，就能抢先放入同名 framework 实现劫持**。/Applications 下默认需要管理员权限，所以风险是中等。
- node-screenshots 的 LC_ID_DYLIB 残留上游 GitHub Actions 路径，只是信息泄露，不影响加载。

### 2.6 4 个 asar 完整性不符的文件：判断结论

用 python3 -I 解析 app.asar header（共 53,222 个条目，其中 773 个 unpacked），逐个算 unpacked 文件的 SHA256 并与 header 里的 integrity.hash 比较，只有 4 个不符：

| 文件 | header.size | 实际字节 | 增量 | 签名时间戳 |
|---|---|---|---|---|
| DalDecrypt_mac | 9,016 | 28,432 | +19,416 | 13:38:21 |
| darwin/7za | 1,635,860 | 1,667,968 | +32,108 | 13:38:12 |
| libvips-cpp.8.17.3.dylib | 17,990,464 | 18,150,048 | +159,584 | 13:38:22 |
| node-screenshots.darwin-x64.node | 713,440 | 738,080 | +24,640 | 13:38:51 |

判断：**是官方构建流程造成的 asar 元数据过期（打包后重签名），不是插件改动。** 依据：
1. 这 4 个文件正好是 unpacked 目录里**全部**的 Mach-O 文件；同目录的 ELF（DalDecrypt_linux、linux/7za）、JS、wasm 和其他 769 个文件的哈希全部一致。
2. 4 个文件都比 header 记录的大 19K–160K，都带有 LC_CODE_SIGNATURE，签名者都是官方 Team F63Y***，时间戳都在主程序签名（13:39:23）之前几十秒。这正好对应 electron-builder 的顺序：先生成 asar header（计算 integrity），再对 unpacked 里的 Mach-O 执行 codesign（往文件末尾追加签名块，文件变大）。
3. 整包 `codesign --verify --deep --strict` 和公证都通过。插件如果替换了这些文件，要么封印校验失败，要么需要拿到携程的 Developer ID 私钥。
4. Electron 的 asar integrity 只校验 header 哈希（与 Info.plist 一致），不校验 unpacked 文件，所以运行时不受影响。

与 03-defects.md 的 SUP-04 结论**复核一致**（本报告补充了逐文件的字节增量和 Windows 反证）。


## 3. Windows 原生清单与签名

### 3.1 PE 汇总（inspect-pe-certificates / imports / resources / load-config；DllCharacteristics 由 python3 -I 读 PE 头补充）

| # | 文件 | 归属 | 格式 / 缓解 | Authenticode | 关键导入（非系统） | TLS 回调 | VERSIONINFO |
|---|---|---|---|---|---|---|---|
| w1 | 旅游商家桌面版.exe | 官方 | PE32+，HEVA/ASLR/NX/CFG | **无证书表** | ffmpeg.dll；延迟加载 34 个（含 bthprops.cpl、WINUSB、dhcpcsvc、pdh） | 7 | Company=`shenghuilu@trip.com`，1.2.12.2679625 |
| w2 | Uninstall 旅游商家桌面版.exe | 官方（NSIS） | PE32，ASLR/NX，无 CFG | **无** | 7 个系统 DLL | 0 | 同上 |
| w3 | resources/elevate.exe | 官方（electron-builder 自带） | PE32，ASLR/NX | **无** | 3 个系统 DLL | 0 | Johannes Passing，Elevate 1.0.0.2894（2007） |
| w4/w5 | ffmpeg.dll / libEGL.dll | 官方（Electron） | PE32+ 全缓解 | 无 | — | 0/1 | ANGLE 2.1.21853 |
| w6 | TripVendorCompanion/旅游商家助手.exe | **插件** | PE32+ 全缓解 | **无** | ffmpeg、CRYPTUI、MMDevAPI、wevtapi、tbs；延迟加载 52 个 | 6 | **Electron 44.7.2**（GitHub, Inc. 原版资源，没有改品牌） |
| w7/w8 | Companion 的 ffmpeg.dll / dxcompiler.dll | 插件 | PE32+ 全缓解 | 无 | — | 0 | DirectX Compiler（Dawn 定制版）1.9.2607 |
| w9 | …/native/windows/TravelMerchant.WindowHelper.exe | **插件** | PE32+ 全缓解 | **无** | 17 个系统 DLL | 2 | 1.0.0.0，OriginalFilename=`.dll`（.NET apphost） |
| w10 | …/native/windows/wpfgfx_cor3.dll | 插件携带的 .NET 运行时 | PE32+ | **有 1 个 PKCS#7（SHA-256）**，微软签名 | D3DCompiler_47_cor3、WindowsCodecs | 0 | .NET 10.0.1326 |
| w11 | …/vcruntime140_cor3.dll | 插件携带 | PE32+ | rea 返回 invalid_request（证书表格式超出解析器范围，待用 osslsigncode 复核） | — | 0 | MSVC 14.44.35211 |
| w12 | node-screenshots.win32-x64-msvc.node | 官方依赖 | PE32+，无 CFG 标记 | 无 | 12 个系统 DLL | 1 | — |
| w13 | @img/sharp-win32-x64/lib/sharp-win32-x64-0.35.5.node | 官方依赖 | PE32+ | 无 | libvips-42.dll、libvips-cpp-8.18.7.dll、**node.exe（延迟加载）** | 0 | — |
| w14 | libvips-cpp-8.18.7.dll | 官方依赖 | PE32+ | 无 | libvips-42.dll | 0 | — |
| w15 | @ctrip/node-vampire-dal/bin/DalDecrypt_win.exe | 官方（携程内部包） | **PE32，没有 ASLR/NX/CFG** | 无 | 2 个系统 DLL | 2 | 无版本信息 |
| w16 | @ctrip/node-vampire-npm/bin/tlist.exe | 官方（携程内部包） | PE32 | rea invalid_request（同 w11） | 17 个系统 DLL | 0 | 微软 tlist 10.0.16299（Debugging Tools 再分发） |
| w17 | @ctrip/node-vampire-p7zip/bin/win32/7za.exe | 官方（携程内部包） | PE32，ASLR/NX，无 CFG | 无 | 5 个系统 DLL | 0 | 7-Zip 18.05（2018） |

另外 `node-vampire-npm/bin/api-ms-win-core-com-l1-1-0.dll` 是随包分发的 API-Set 转发 DLL，放在 tlist.exe 旁边，属于 DLL 搜索顺序上的冗余文件。

### 3.2 结论

- **Windows 官方包整体没有 Authenticode 签名**：主程序、卸载器、elevate、全部 .node/.dll 都没有 IMAGE_DIRECTORY_ENTRY_SECURITY。插件清单 `vendor-runtime-manifest.json` 和 `receipt.json` 记录的 executableSha256 `4fad***` 与当前主程序一致，说明插件**没有改过 exe**。所以“未签名”是官方状态，不是插件剥离的结果。用户首次安装会遇到 SmartScreen“未知发布者”提示，electron-updater 也无法做发布者校验（见 §5）。
- 插件（Windows）实际改动（依据 receipt.json，kind=`trip-vendor-windows-injection-v1`，version 0.5.41）：①把 `resources/app.asar` 替换为补丁版（原包 SHA256 `e1cd***` 备份到 `TripVendorCompanion.Install/original.asar`，我们重算一致；补丁版 `f3f6***`），asar 里多出 `trip-vendor-bootstrap.cjs`、`companion-vendor-original-main.json`；②改写 5 个 unpacked 渲染层文件：`imPlus/index.html`、`imWindow-*.js`、`main/index.html`、`mainWindow-*.js`、`packageVersion.json`；③新增一套完整的 Electron 44.7.2 运行时（`TripVendorCompanion/`，496 MB）和一个 .NET 窗口辅助程序（`TravelMerchant.WindowHelper.exe` + WPF 原生 DLL）。这些文件都没有签名。
- Windows 版 asar 的 781 个 unpacked 文件 integrity 全部一致（没有 codesign 步骤改写字节），反过来印证了 Mac 版 4 个不符文件是签名造成的（§2.6）。
- PE 缓解：Electron 二进制都启用了 CFG/HEVA；携程内部 vampire 工具链（DalDecrypt_win、7za 18.05、tlist）是 32 位旧二进制，DalDecrypt_win 连 ASLR/NX 都没有。

## 4. Electron fuses 对比

| Fuse | Mac 1.2.13 主程序 | Win 1.2.12 主程序 | 插件 Companion（Electron 44.7.2） | Tauri 对应要求 |
|---|---|---|---|---|
| RunAsNode | enabled | enabled | enabled | 不适用（没有 Node 运行时） |
| EnableCookieEncryption | disabled | disabled | disabled | Cookie/凭据放钥匙串或 DPAPI |
| EnableNodeOptionsEnvironmentVariable | enabled | enabled | enabled | 不适用 |
| EnableNodeCliInspectArguments | enabled | enabled | enabled | release 构建禁用 devtools |
| EnableEmbeddedAsarIntegrityValidation | disabled | disabled | disabled | 资源嵌入二进制，靠签名覆盖 |
| OnlyLoadAppFromAsar | disabled | disabled | disabled | — |
| LoadBrowserProcessSpecificV8Snapshot | disabled | disabled | disabled | — |
| GrantFileProtocolExtraPrivileges | （v27 没有这个 fuse） | （没有） | enabled | 不注册 file 特权 |
| WasmTrapHandlers | （没有） | （没有） | enabled | — |

- 两版官方包的 fuses **完全相同，都是 Electron 出厂默认值**，官方没有做 fuse 加固；sentinel 偏移不同（Mac 131,109,072 / Win 144,433,152）只是因为二进制不同。
- 影响：`RunAsNode` + `NodeOptions` + `NodeCliInspect` 全开，任何本地进程都可以用 `ELECTRON_RUN_AS_NODE=1` 或 `--inspect` 把带携程签名的主程序当成通用 Node 解释器使用，并继承它的 TCC 权限（相机、麦克风、屏幕录制）。在 Mac 上这会绕过 Developer ID 签名信任。`EmbeddedAsarIntegrityValidation=disabled` 意味着 Info.plist 里的 ElectronAsarIntegrity 不会被强制校验。Windows 插件正是利用这一点替换了 app.asar（Windows 上 Electron 27 本来也不支持 asar 完整性校验）。
- 插件的 Companion 同样没有做任何 fuse 加固。

## 5. 更新与热更新链路

### 5.1 配置

| 项 | Mac 1.2.13 | Win 1.2.12 |
|---|---|---|
| app-update.yml | `provider: generic`、`url: ''`、`updaterCacheDirName: vbk-electron-updater` | 同 Mac |
| app-update.yml 的 publisherName | 无 | 无（Windows 上 electron-updater 因此跳过发布者签名校验） |
| packageVersion.json pkgVersion / aresVersion | 1.2.13 / 1.2.18 | 1.2.12 / 1.2.15（**这个文件被插件改写过**，见 §3.2） |
| feedUrl | `https://file.tripcdn.com/files/8/tour_vbkadminuser/vbk-electron-v27/1.2.13` | `…/vbk-electron-v27/1.2.12` |
| distUrl | `…/1.2.13/dist/1.2.18/dist.zip` | `…/1.2.12/dist/1.2.15/dist.zip` |
| 依赖 | electron-updater 6.3.9、adm-zip 0.5.16 | 同 Mac |

### 5.2 流程（facts/*-main-split.txt 第 1505–1560 行，两版代码逻辑相同）

1. `initUpdateInfo`：读取本地 `VITE_PUBLIC/packageVersion.json`，再用 `Ou()` 拉取远端 `https://static.tripcdn.com/packages/vacation/vbk-electron-v27/*/packageVersion.json?<ts>`（开发环境是 static.fws.qa.nt.ctripcorp.com）。请求走 `session.defaultSession`，超时 1.5 s，失败时静默返回 null。
2. **整包更新** `checkPkgUpdate`：用远端的 `feedUrl` 调 `autoUpdater.setFeedURL(r)`。也就是说，app-update.yml 里的 url 留空，**更新源地址完全由远端 JSON 决定**。之后 `autoDownload=e`、`autoInstallOnAppQuit=true`、`checkForUpdates()`；强制更新时用 `quitAndInstall(true,true)`（静默安装并重启）。electron-updater 会用 latest(-mac).yml 里的 sha512 校验下载文件。Mac 上再由 Squirrel.Mac/ShipIt 校验新包的代码签名（Designated Requirement）。Windows 上没有 publisherName 且安装包本身未签名，**只剩同源 yml 的 sha512 这一道校验**。
3. **渲染层热更新** `checkRenderUpdate → downloadBundleZip → replaceNewVersion`：
   - 比较 aresVersion 后下载 distUrl。代码里写着 `e.startsWith("https://")&&(e=e.replace("https://","http://"))`，**主动把 HTTPS 降级成 HTTP**，再用 `http.get` 下载到 `userData/dist.zip`，30 s 超时。
   - 下载完成后直接 `new AdmZip(Ht).extractAllTo(USER_DIST, true, true)` 覆盖解压。失败时从 `dist.back` 回滚，最后设置 `process.env.UNPACKED_DIST=USER_DIST`，之后所有页面都从用户目录加载。
   - 全程**没有任何哈希、签名或大小校验**。split 文本里 `createHash` 只出现在 drizzle 迁移（第 1123 行），`sha512`、`verify` 都没有命中。解压用的是 adm-zip，**不是 7za**。主进程代码没有直接引用 7za、DalDecrypt、tlist，它们由 @ctrip/node-electron-hotfix → node-vampire-* 依赖链带入（与 03 的 SUP-05 一致）。
4. 风险链：远端 JSON（HTTPS；非 PROD 环境会开启 `ignore-certificate-errors`，见 03 的 SEC-06）→ distUrl（被强制改成 HTTP）→ 无校验的 zip → 覆盖整个渲染层。渲染层页面有 `webSecurity:false`，还能调用 appBridge 的 `dbQuery`、`getAllLoginCookies`、`downloadFile`。所以**同网段的中间人可以直接替换全部前端代码并读取登录 Cookie 和本地数据库**。这是本报告最严重的问题（N-01，与 03 的 SUP-01 复核一致）。另外 adm-zip 的 `extractAllTo` 第三个参数 keepOriginalPermission=true，需要关注 zip-slip（0.5.16 已修复 `../` 路径穿越，但符号链接条目仍要留意）。

## 6. 体积与依赖

### 6.1 安装包构成

| 项 | Mac 1.2.13 | Win 1.2.12（含插件） |
|---|---|---|
| 安装目录总计 | **744 MB** | 1.5 GB（其中插件 Companion 496 MB + original.asar 备份 335 MB） |
| Frameworks / Electron 运行时 | 222 MB | ≈170 MB（主 exe 172.7 MB） |
| app.asar | 347 MiB（53,222 个条目） | 351 MB（44,212 个条目，插件补丁版） |
| app.asar.unpacked | 174 MiB（773 个文件，多数是 dist 和 OCR 模型） | 781 个文件 |
| 解包 node_modules | 639 MB / 960 个包 / 113 个包存在多版本 | 605 MB / 873 个包 / 105 个包存在多版本 |

### 6.2 node_modules 体积 Top 20

- Mac：onnxruntime-web 132.5M、antd 53.1M、better-sqlite3 20.7M、sqlite3 20.2M、date-fns 18.8M、@img/sharp-libvips-darwin-x64 17.3M、lottie-web 14.9M、core-js 14.7M、@ant-design/icons-svg 13.3M、@larksuiteoapi/node-sdk 12.6M、@ant-design/icons 12.3M、@ctrip/xtaro 8.7M、drizzle-orm 8.5M、@ctrip/nfes-ui 8.3M、xlsx 7.0M、@ctrip/trip-escheck 6.5M、@npmcli/run-script 6.4M、codepage 5.8M、@ctrip/design-tokens-next 5.7M、@ctrip/xtaro-sdui-client-h5 5.7M。
- Win：onnxruntime-web 132.5M、antd 53.1M、sqlite3 45.4M、better-sqlite3 40.7M、@img/sharp-win32-x64 18.9M、date-fns 18.8M、core-js 14.7M、@ant-design/icons-svg 13.3M、@larksuiteoapi/node-sdk 12.6M、@ant-design/icons 12.3M、drizzle-orm 8.5M、xlsx 7.0M、@ctrip/trip-escheck 6.5M、@npmcli/run-script 6.4M、codepage 5.8M、region-selector 5.6M、rx 5.2M、moment 5.1M、lodash 4.9M、jimp 4.8M。

观察：
- 主进程 node_modules 里打进了大量只在渲染层或开发期使用的包：antd、@ant-design/icons、core-js、lottie-web、@ctrip/xtaro*（前端已经由 Vite 打进 dist），以及 @npmcli/run-script、@larksuiteoapi/node-sdk（飞书 SDK）、heapdump、redux-devtools-extension。估计有 150 MB 以上属于冗余。
- **sqlite3 和 better-sqlite3 两套 SQLite 驱动同时存在**（Win 合计 86 MB）。onnxruntime-web（132 MB，含 wasm 全变体）+ paddleocr + jimp + sharp 组成了 OCR 链路。
- 多版本重复：lru-cache ×5、strip-ansi ×5、string-width ×5、semver ×4、glob ×4、minimatch ×4、**axios ×4（0.19.2 / 0.27.2 / 0.28.1 / 1.13.6，0.19.2 有已知 SSRF/ReDoS CVE）**、uuid ×3、debug ×3（含 2.6.9）。
- sharp 原生绑定不一致：两版 `sharp` 都是 0.34.5。Mac 只带了 `@img/sharp-libvips-darwin-x64` 1.2.4（libvips 8.17.3），**没有 `@img/sharp-darwin-x64` 的 .node**。Win 带的是 `sharp-win32-x64-0.35.5.node` + libvips 8.18.7，与 JS 层 0.34.5 版本不匹配。两版的 sharp 都可能在运行时加载失败（待实机确认）。
- 跨平台死文件：Mac 包带了 Linux ELF（DalDecrypt_linux、linux/7za）。

### 6.3 与自研 Tauri 包对比（引用 04-target-vs-vbk-gap.md §产物，本次复核）

| 项 | 官方 Mac 1.2.13 | 自研 vbk（Tauri） |
|---|---|---|
| 体积 | 744 MB | `.app` 17–19 MB / `.dmg` 7.0 MiB；Windows NSIS 6.6 MB / exe 20.5 MB（round6 记录） |
| 架构 | 仅 x86_64（Apple Silicon 需 Rosetta） | arm64（release/macos 旧包 17 MB；最新构建 19 MB） |
| 签名 | Developer ID + Hardened Runtime + 公证 + 装订 | **adhoc、linker-signed，无 Team ID，无 hardened runtime，未公证**（复核一致） |
| 更新 | electron-updater + 热更新 dist.zip | **没有 updater 插件**，更新窗口显示“更新服务尚未配置”（复核一致） |
| Windows 签名 | 无 | 无（未见签名配置） |

## 7. 问题清单

| ID | 级别 | 归属 | 问题 | 证据 | 对应 03-defects |
|---|---|---|---|---|---|
| N-01 | **P0** | 官方 | 渲染层热更新把 distUrl 从 HTTPS 强制降级为 HTTP，zip 不做任何哈希或签名校验就用 adm-zip 覆盖解压到 USER_DIST，之后从该目录加载全部页面。结合 webSecurity:false 和 appBridge（dbQuery、getAllLoginCookies），中间人可以执行任意代码、窃取 Cookie 和本地库 | split 1505–1560：`replace("https://","http://")`、`extractAllTo(e,!0,!0)` | SUP-01（复核一致） |
| N-02 | **P1** | 官方 | 整包更新源由远端 packageVersion.json 动态下发（`setFeedURL(remote.feedUrl)`），信任完全取决于这一次 HTTPS 拉取；非 PROD 环境还会开启 `ignore-certificate-errors`，而环境判定来自可写配置。Windows 无 publisherName、安装包未签名，整包更新只靠同源 sha512 | app-update.yml `url: ''`；split `setFeedURL(r)` | SEC-06、SUP-03（新发现：feedUrl 动态下发） |
| N-03 | **P1** | 官方 | Windows 官方包（主程序、卸载器、elevate、全部原生模块）都没有 Authenticode 签名，会触发 SmartScreen，也无法校验更新包发布者 | pe-cert w1/w2/w3/w12–w17 entries=0 | SUP-03、SUP-06（复核一致，补充 .node/vampire 工具也未签名） |
| N-04 | **P1** | 官方 | Electron fuses 全部是默认值：RunAsNode、NODE_OPTIONS、--inspect 全开，asar 完整性校验关闭。带携程签名的二进制可以被当作 Node 解释器使用并继承 TCC 授权；Windows app.asar 可以被任意替换（插件正是这样做的） | mac/fuses.json、out/win-fuses.json | SEC-04（复核一致） |
| N-05 | **P1** | 官方 | Mac entitlements 同时启用 disable-library-validation 和 allow-dyld-environment-variables，并且套用到所有 Helper 和工具。Hardened Runtime 的防注入作用失效；trace-dylib 有 17 条“更靠前的 rpath 候选位置不存在”，可被抢占 | inspect-signature n1–n9；mac-dylib.json findings | SEC-05（复核一致，新增 rpath 抢占面） |
| N-06 | **P1** | 插件 | Windows 插件替换 app.asar、改写 5 个渲染层文件（含 packageVersion.json），并植入未签名的 Electron 44.7.2 Companion 和 .NET 辅助程序，开启 remote-debugging-port。官方没有任何完整性机制能发现这些改动 | receipt.json、vendor-runtime-manifest.json | PLG-01/02/03（复核一致；新增 5 个 unpacked 渲染层文件被改写） |
| N-07 | P2 | 官方 | 仅 x86_64，Apple Silicon 需要 Rosetta；包内有 archGuide 文案，但没有 arm64/universal 包 | inspect-macho architectures.total=1 | 新发现 |
| N-08 | P2 | 官方 | ATS 全局 `NSAllowsArbitraryLoads=true`，与 N-01 的 HTTP 下载配合放大风险 | inspect-plist | 新发现 |
| N-09 | P2 | 官方 | asar header 的 unpacked integrity 与 4 个 Mach-O 实际字节不符（签名在 header 之后执行），任何依赖 header 校验 unpacked 文件的工具都会误报；DalDecrypt_mac 和 captureTool 没有执行位 | §2.6 | SUP-04（复核一致） |
| N-10 | P2 | 官方 | sharp 原生绑定缺失（Mac）或版本不匹配（Win 0.34.5 vs 0.35.5），OCR 预处理可能失效 | §6.2 | 新发现 |
| N-11 | P2 | 官方 | 依赖臃肿：两套 SQLite 驱动、渲染层和开发包进入运行时、axios 0.19.2 等过期版本，node_modules 超过 600 MB | §6.2 | 新发现 |
| N-12 | P3 | 官方 | 携程内部 vampire 工具是 32 位旧二进制：7za 18.05（2018）、DalDecrypt_win 无 ASLR/NX、tlist 再分发；Mac 包带 Linux ELF 死文件 | §3.1 / §2.4 | SUP-05（部分一致） |
| N-13 | P3 | 官方 | 权限文案是 Electron 模板英文，声明了用不到的蓝牙权限；LSApplicationCategoryType 写成 developer-tools；node-screenshots 残留 CI 路径 | inspect-plist / macho n6 | 新发现 |

## 8. 对 Tauri 打包、签名、更新的要求

1. **签名与公证（对应 N-03/N-05）**：Mac 使用 Developer ID Application 签名，开启 Hardened Runtime 并公证、装订。entitlements 按最小权限配置：不开 `disable-library-validation`、`allow-dyld-environment-variables`；只有 WebView 需要 JIT 时才保留 `allow-jit`。Windows 使用 EV 或 OV 代码签名证书对 exe、NSIS 安装器和卸载器都签名并加时间戳。CI 里加入 `codesign --verify --deep --strict`、`spctl -a`、`signtool verify /pa` 作为门禁。
2. **更新（对应 N-01/N-02）**：使用 tauri-plugin-updater，minisign 公钥编译进二进制，endpoint 固定为 HTTPS 常量，不从远端 JSON 动态下发。更新包必须先验签再安装。禁止任何 HTTPS→HTTP 降级，不关闭证书校验。如果以后要做前端热更新，必须使用“签名清单（版本、文件、sha256）+ 原子目录切换 + 回滚”，并且只从 tauri asset 协议加载，不能出现 webSecurity:false 这类做法。
3. **运行时加固（对应 N-04）**：Tauri 没有 RunAsNode 这类风险。release 构建关闭 devtools，不接受 `--remote-debugging-port`、`--inspect` 等启动参数；CSP 和 capabilities 保持最小化（04 报告已确认只有 adapter.json 是 remote 能力）。
4. **完整性（对应 N-06/N-09）**：前端资源嵌入二进制，由代码签名覆盖，不保留可写的 unpacked 目录。启动时可以校验自身签名状态并上报，用来发现类似 Windows 插件的篡改。
5. **架构（对应 N-07）**：Mac 出 universal（arm64 + x86_64）包或分别出两个包；Windows 出 x64，可选 arm64。
6. **原生依赖（对应 N-10/N-12）**：OCR 和截图用 Rust crate 或系统 API（Vision.framework、Windows.Media.Ocr、ScreenCaptureKit）实现，不再随包分发 7za、tlist 等外部可执行文件。如果必须带 sidecar，每个都要签名，并在 tauri.conf 的 externalBin 里声明。
7. **体积预算**：保持 Mac dmg 不超过 15 MB、Windows 安装包不超过 15 MB。在 CI 里记录体积，并生成 SBOM（cargo-auditable 或 cargo-cyclonedx，04 报告指出当前缺少 `.dep-v0`）。
8. **Info.plist**：不开 NSAllowsArbitraryLoads；只声明真正用到的 TCC 权限，文案用中文写清用途；如果保留 `vbookingChat` 深链，必须对参数做白名单校验；LSMinimumSystemVersion 跟随 Tauri 要求（≥10.15）。

## 附录 A. 命令

工作目录 `~/tools/rea-work/native/out/`，所有输出都是 `--format json` 重定向到文件，再用 `python3 -I` 提取。

```bash
R=~/tools/rea/rea; A="/Applications/旅游商家桌面版.app"; W=~/Downloads/vbk-electron
$R inspect-plist "$A" --format json > mac-plist.json
$R inspect-signature "$A" --format json > mac-sig-app.json
$R inspect-macho "$A/Contents/MacOS/旅游商家桌面版" --format json > mac-macho-main.json
$R inspect-macho "$A/Contents/Frameworks/Electron Framework.framework/Electron Framework" --format json > mac-macho-ef.json
$R trace-dylib-resolution "$A" --format json > mac-dylib.json
# n1..n9：Electron Framework、Squirrel、ShipIt、Helper.app、captureTool、4 个 unpacked Mach-O
$R inspect-signature "<file>" --format json > sig-nN.json; $R inspect-macho "<file>" --format json > macho-nN.json
# 只读系统校验（不执行目标）
codesign --verify --deep --strict --verbose=2 "$A"; spctl -a -vv -t exec "$A"; xcrun stapler validate "$A"
# w1..w17（列表见 out/widx.txt）
$R inspect-pe-certificates "$W/<f>" --max-file-bytes=300000000 --format json > pe-cert-wN.json
$R inspect-pe-imports      "$W/<f>" --max-file-bytes=300000000 --max-functions=60000 --format json > pe-imp-wN.json
$R inspect-pe-resources    "$W/<f>" --max-file-bytes=300000000 --format json > pe-res-wN.json
$R inspect-pe-load-config  "$W/<f>" --max-file-bytes=300000000 --format json > pe-lc-wN.json
$R inspect-electron-fuses "$W/旅游商家桌面版.exe" --format json > win-fuses.json
$R inspect-electron-fuses "$W/resources/TripVendorCompanion/旅游商家助手.exe" --format json > comp-fuses.json
```

- asar 完整性：python3 -I 读取 app.asar 前 16 字节得到 header 长度，解析 JSON，遍历 `unpacked:true` 的条目，对照 `app.asar.unpacked/<path>` 的 SHA256 与 `integrity.hash`；header 原始字节的 SHA256 与 Info.plist ElectronAsarIntegrity 对比。
- 更新链路：python3 -I 在 `facts/{mac,win}-main-split.txt` 里检索 setFeedURL、autoDownload、adm-zip、createHash、sha512、verify、p7zip 等关键字；`sed -n '1505,1560p'` 读取更新类代码。
- 依赖：`du -sk node_modules/* node_modules/@*/*` 取 Top 20；`os.walk` 解析 package.json 的 name@version 统计多版本（只读，不执行）。
- 插件证据：`resources/TripVendorCompanion.Install/receipt.json`、`TripVendorCompanion/vendor-runtime-manifest.json`（哈希只保留前 8 位）。
