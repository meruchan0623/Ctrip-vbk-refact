/** Compact package typography, isolated by the companion-card shadow root. */
export const COMPANION_CARD_STYLE = `:host{all:initial;
--accent:#2f54d6;--accent-ink:#1e3fb8;--accent-soft:#edf1fd;--ink:#171d2b;--ink-2:#454e62;--ink-3:#6b7386;--line:#e4e8ef;--line-soft:#eef1f6;--sunken:#f5f6f9;--hover:#eaedf3;
--ok:#13794f;--ok-soft:#e3f3ea;--warn:#9a5a00;--warn-soft:#fcf1dc;--bad:#b9342b;--bad-soft:#fbe9e7;--muted-soft:#eef0f4;
--sans:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI','Microsoft YaHei',sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--fs-micro:10px;--fs-tiny:10.5px;--fs-xs:11px;--fs-sm:11.5px;--fs-md:12px;--fs-base:12.5px;--fs-hero:21px;--value-weight:600;--mono-weight:400;--pad:12px;
font:var(--fs-md)/1.45 var(--sans);color:var(--ink);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;text-size-adjust:100%;-webkit-user-select:text;user-select:text}
*{box-sizing:border-box;font:inherit;min-width:0}
button{-webkit-user-select:none;user-select:none;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;white-space:nowrap;text-align:left}
button:focus-visible,.cdrs:focus-visible{outline:2px solid var(--accent);outline-offset:1px;border-radius:6px}
button:disabled{opacity:.4;cursor:not-allowed}
svg{width:14px;height:14px;flex:none;stroke:currentColor;fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.card{display:flex;flex-direction:column;max-height:inherit;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 2px rgba(23,29,43,.05),0 12px 32px -8px rgba(23,29,43,.16);overflow:hidden;animation:rise .14s ease-out}
.head{flex:none;display:flex;align-items:center;gap:8px;min-height:38px;padding:0 6px 0 var(--pad);border-bottom:1px solid var(--line-soft);background:linear-gradient(180deg,#fbfcfe,#fff);cursor:pointer;-webkit-user-select:none;user-select:none}
.collapsed .head{border-bottom-color:transparent}
.tg{flex:1;align-self:stretch;display:flex;align-items:center;gap:8px;margin-left:calc(-1 * var(--pad));padding-left:var(--pad)}
.tg:focus-visible{outline-offset:-2px}.tg:hover .title{color:var(--accent-ink)}
.title{font-weight:650;font-size:var(--fs-base);letter-spacing:.01em;white-space:nowrap}
.count{font-size:var(--fs-xs);color:var(--ink-3);white-space:nowrap;padding:1px 6px;border-radius:9px;background:var(--sunken)}
.icon{width:26px;height:26px;display:grid;place-items:center;border-radius:7px;color:var(--ink-2);flex:none}
.icon:hover:not(:disabled){background:var(--hover);color:var(--ink)}
.busy .refresh svg{animation:spin .8s linear infinite}
.toggle svg{transition:transform .15s}.collapsed .toggle svg{transform:rotate(-90deg)}
.body{flex:1 1 auto;overflow:auto;overscroll-behavior:contain;padding:0 var(--pad)}
.collapsed .body,.collapsed .foot{display:none}
/* A hairline scrollbar on the card's right edge; the content keeps its own padding. */
.body::-webkit-scrollbar{width:3px;height:3px}.body::-webkit-scrollbar-track{background:transparent}
.body::-webkit-scrollbar-thumb{background:rgba(23,29,43,.28);border-radius:2px}.body::-webkit-scrollbar-thumb:hover{background:rgba(23,29,43,.5)}
.body::-webkit-scrollbar-button{display:none;width:0;height:0}
.tabs{display:flex;gap:4px;margin:0 calc(-1 * var(--pad));padding:8px 18px 7px var(--pad);overflow-x:auto;scrollbar-width:none;border-bottom:1px solid var(--line-soft);-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent)}
.tabs::-webkit-scrollbar{display:none}
.tab{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:7px;border:1px solid transparent;color:var(--ink-2);font-size:var(--fs-sm);flex:none}
.tab:hover:not([aria-selected="true"]){background:var(--sunken)}
.tab[aria-selected="true"]{background:#fff;color:var(--ink);font-weight:650;border-color:var(--line);box-shadow:0 1px 2px rgba(23,29,43,.06)}
.tab i{width:6px;height:6px;border-radius:50%;background:#9aa2b3}
.tab i[data-tone="ok"]{background:#1fa36a}.tab i[data-tone="warn"]{background:#e7a034}.tab i[data-tone="bad"]{background:#e0574c}
.tab .st{font-size:var(--fs-tiny);color:var(--ink-3);font-weight:400}
.more{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:7px;border:1px dashed #c9d0dc;color:var(--ink-3);font-size:var(--fs-tiny);white-space:nowrap;flex:none}
.row{padding:10px 0;border-bottom:1px solid var(--line-soft)}.row:last-child{border-bottom:0}
.none{color:var(--ink-3);font-weight:400}
.hero{display:grid;grid-template-columns:44px minmax(0,1fr);column-gap:10px;align-items:center}
.ring,.mini{position:relative;display:block;flex:none}.ring{width:44px;height:44px}.mini{width:22px;height:22px}
.ring svg,.mini svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}
.ring svg{stroke-width:4}.mini svg{stroke-width:3.5}
.tr{stroke:#e6e9f0}.fg{stroke:var(--accent);transition:stroke-dasharray .4s}
[data-tone="warn"]>svg .fg{stroke:#e7a034}[data-tone="over"]>svg .fg{stroke:#e0574c}[data-tone="muted"]>svg .fg{stroke:#c3c9d5}
.ring b{position:absolute;inset:0;display:grid;place-items:center;font-size:var(--fs-tiny);font-weight:600;line-height:1;white-space:nowrap;color:var(--ink-2)}
.lab{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:var(--fs-xs);color:var(--ink-3)}
.num{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px;line-height:1.1;margin-top:1px}
.num b{overflow-wrap:anywhere;font-size:var(--fs-hero);font-weight:700;letter-spacing:-.015em;-webkit-user-select:text;user-select:text}.num b.none{font-weight:700}
.num span{overflow-wrap:anywhere;font-size:var(--fs-sm);color:var(--ink-3)}
.sub{display:flex;flex-wrap:wrap;gap:0 10px;margin-top:2px;font-size:var(--fs-xs);color:var(--ink-2)}
.sub>span{overflow-wrap:anywhere}
.sub em{font-style:normal;color:var(--ink-3)}
.pill{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:9px;font-size:var(--fs-tiny);font-weight:650;white-space:nowrap;background:var(--muted-soft);color:var(--ink-2)}
.pill::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
[data-tone="ok"].pill{background:var(--ok-soft);color:var(--ok)}[data-tone="warn"].pill{background:var(--warn-soft);color:var(--warn)}[data-tone="bad"].pill{background:var(--bad-soft);color:var(--bad)}
.nm{display:flex;flex-direction:column;gap:3px}
.ch{font-weight:650;font-size:var(--fs-base);line-height:1.35;overflow-wrap:anywhere;-webkit-user-select:text;user-select:text}
.src{font-size:var(--fs-xs);line-height:1.4;color:var(--ink-3);overflow-wrap:anywhere;-webkit-user-select:text;user-select:text}
.src::before{content:"源";display:inline-block;margin-right:5px;padding:0 4px;border-radius:3px;background:var(--sunken);color:var(--ink-3);font-size:var(--fs-micro);line-height:15px}
/* Columns grow toward their content, so a short supplier code stays whole while a long name still wraps. */
.spec{display:grid;grid-template-columns:repeat(3,minmax(0,auto));gap:6px;margin-top:8px}
.spec div{padding:5px 7px;border-radius:7px;background:var(--sunken);display:flex;flex-direction:column;gap:1px}
.spec small{font-size:var(--fs-micro);color:var(--ink-3);white-space:nowrap}
.spec b{font-size:var(--fs-sm);font-weight:var(--value-weight);overflow-wrap:anywhere;-webkit-user-select:text;user-select:text}.spec b.none{font-weight:400}
.mono{font-family:var(--mono);font-weight:var(--mono-weight)}.spec b.mono{font-size:var(--fs-xs);font-weight:600}
.spec b[data-tone="ok"]{color:var(--ok)}.spec b[data-tone="warn"]{color:var(--warn)}.spec b[data-tone="bad"]{color:var(--bad)}
.ids{display:grid;grid-template-columns:44px minmax(0,1fr) 22px;column-gap:6px;row-gap:3px;margin:0;align-items:center}
.ids dt{font-size:var(--fs-xs);color:var(--ink-3);white-space:nowrap}
.ids dd{margin:0;font-family:var(--mono);font-weight:var(--mono-weight);font-size:var(--fs-sm);letter-spacing:.02em;word-break:normal;overflow-wrap:anywhere;line-height:1.4;-webkit-user-select:text;user-select:text}
.ids dd.txt,.ids dd.none{font-family:inherit;letter-spacing:0}
.copy{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;color:var(--ink-3)}
.copy:hover{background:var(--accent-soft);color:var(--accent)}.copy svg{width:12px;height:12px}.copy.done{color:var(--ok)}
.heading{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:5px;font-size:var(--fs-xs);color:var(--ink-3)}
.heading b{font-weight:600;color:var(--ink-2);white-space:nowrap}
/* Up to ten CDRs: the list scrolls under the pointer about five rows tall, without moving the card body. */
.cdrs{list-style:none;margin:0;padding:0 3px 0 0;display:flex;flex-direction:column;gap:3px;max-height:132px;overflow-y:auto;overscroll-behavior:contain}
.cdrs::-webkit-scrollbar{width:3px}.cdrs::-webkit-scrollbar-thumb{background:rgba(23,29,43,.22);border-radius:2px}.cdrs:hover::-webkit-scrollbar-thumb{background:rgba(23,29,43,.4)}
.cdr{position:relative;flex:none;display:grid;grid-template-columns:76px minmax(0,1fr) auto;column-gap:8px;align-items:center;min-height:24px;padding:3px 7px;border-radius:6px;background:var(--sunken);overflow:hidden;font-size:var(--fs-xs);line-height:1.3}
.cdr .bar{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,rgba(47,84,214,.12),rgba(47,84,214,.04))}
.cdr>*{position:relative}
.cdr time{font-family:var(--mono);font-weight:var(--mono-weight);color:var(--ink-2);white-space:nowrap}
.cdr time.today{color:var(--accent-ink);font-weight:600}
.cdr .op{overflow-wrap:anywhere}
.cdr b{font-weight:650;white-space:nowrap}
.empty{margin:0;padding:7px 9px;border-radius:6px;background:var(--sunken);color:var(--ink-3);font-size:var(--fs-xs)}
.sum{flex:none;display:flex;align-items:center;gap:8px;padding:8px var(--pad);font-size:var(--fs-md)}
.sum b{font-weight:650;white-space:nowrap}.sum span:last-child{flex:1;color:var(--ink-3);font-size:var(--fs-xs);overflow-wrap:anywhere}
.callout{display:flex;align-items:flex-start;gap:9px;padding:14px 0 10px;color:var(--ink-2)}
.callout svg{width:16px;height:16px;margin-top:1px}
.callout[data-tone="info"] svg{color:var(--accent)}.callout[data-tone="warn"] svg{color:var(--warn)}.callout[data-tone="bad"] svg{color:var(--bad)}
.callout div{flex:1;display:grid;gap:8px;justify-items:start}.callout p{margin:0;line-height:1.5;overflow-wrap:anywhere}
.solid{height:26px;padding:0 12px;border-radius:7px;background:var(--accent);color:#fff;font-weight:600;font-size:var(--fs-sm);box-shadow:0 1px 2px rgba(47,84,214,.3)}
.solid:hover{filter:brightness(1.07)}
.outline{height:26px;padding:0 12px;border-radius:7px;border:1px solid var(--line);background:#fff;font-weight:600;font-size:var(--fs-sm)}.outline:hover{background:var(--sunken)}
.skeleton{display:grid;gap:8px;padding:12px 0}
.skeleton i{display:block;height:10px;border-radius:5px;background:linear-gradient(90deg,#eef0f4 25%,#f7f8fa 50%,#eef0f4 75%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}
.skeleton .r{display:grid;grid-template-columns:44px 1fr;gap:10px;align-items:center}
.skeleton .r>i{width:44px;height:44px;border-radius:50%}.skeleton .r div{display:grid;gap:6px}
.skeleton .t3{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.skeleton .t3 i{height:34px;border-radius:7px}
.foot{flex:none;display:flex;align-items:center;gap:6px;min-height:28px;padding:0 var(--pad);border-top:1px solid var(--line-soft);background:#fbfcfe;color:var(--ink-3);font-size:var(--fs-tiny);white-space:normal;overflow-wrap:anywhere}
.foot .rel{color:var(--ink-2)}.foot .flash{margin-left:auto;color:var(--ok);font-weight:650}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{to{background-position:-200% 0}}
@keyframes rise{from{opacity:0;transform:translateY(4px)}}
@media (prefers-reduced-motion:reduce){.card{animation:none}.skeleton i,.busy .refresh svg{animation:none!important}.fg{transition:none}}
[hidden]{display:none!important}
:host{--sans:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei UI',sans-serif;--mono:ui-monospace,SFMono-Regular,Consolas,monospace;
--fs-micro:10.5px;--fs-tiny:11px;--fs-xs:11.5px;--fs-sm:12px;--fs-md:12px;--fs-base:13px;--fs-hero:20px;--value-weight:500;--mono-weight:400;--pad:10px;
--ink:#202938;--ink-2:#465268;--ink-3:#707b8d;--line:#d5dae3;--line-soft:#e3e7ee}
.head{min-height:36px}.tab{height:26px}.pill{height:21px;border-radius:11px}.row{padding:7px 0}.tabs{padding-top:6px;padding-bottom:5px}
.spec{gap:4px;margin-top:6px}.spec div{padding:4px 6px}.ids{grid-template-columns:50px minmax(0,1fr) 22px;row-gap:2px}
.cdr{grid-template-columns:minmax(0,76px) minmax(0,1fr) minmax(0,max-content);min-height:26px}.cdr time,.cdr b{white-space:normal;overflow-wrap:anywhere}.cdrs{max-height:142px}.callout{padding:10px 0 8px}
.title{font-weight:600;letter-spacing:0}
.num{line-height:1.2;margin-top:3px}.num b,.num b.none{font-weight:600;letter-spacing:-.02em}
.pill{font-weight:500}.ch{font-weight:500;line-height:1.5}.nm{gap:5px}.src{line-height:1.5}
.spec b.mono{font-family:var(--sans);font-weight:500;letter-spacing:0}
.ids dd{font-family:var(--sans);font-variant-numeric:tabular-nums;letter-spacing:0;line-height:1.55}
.cdr time{font-family:var(--sans);font-variant-numeric:tabular-nums;letter-spacing:0}.cdr time.today{font-weight:500}
.cdr b,.heading b{font-weight:600}.cdr .op{color:var(--ink-2)}
.foot{min-height:26px}.foot .rel{color:var(--ink-3)}.solid,.outline{height:28px}.skeleton{padding:9px 0}
.reissues{padding:6px 0 4px}
.rbar{display:flex;align-items:center;gap:6px;min-width:0}
.rtrack{flex:1;height:38px;display:flex;align-items:center;gap:3px;overflow-x:scroll;overflow-y:hidden;padding:0 1px;scrollbar-width:thin;scrollbar-color:#c9d0dc transparent;overscroll-behavior-x:contain}
.rarrow{flex:none;color:var(--ink-3);font-size:var(--fs-sm);line-height:1}
.rchip{flex:none;display:inline-flex;align-items:center;gap:6px;height:26px;line-height:1;white-space:nowrap;padding:0 9px 0 3px;border:1px solid var(--line);border-radius:13px;background:#fff;font-size:var(--fs-xs);color:var(--ink-2)}
.rchip:hover:not(:disabled):not(.on){border-color:var(--accent)}
.rchip.on{border-color:var(--accent);background:var(--accent-soft);color:var(--ink);box-shadow:0 0 0 2px rgba(47,84,214,.1)}
.rchip:disabled{opacity:.7;cursor:default}
.rtag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border:1px solid var(--accent);border-radius:9px;color:var(--accent-ink);font-size:var(--fs-tiny);font-weight:600}
.rchip time{font-variant-numeric:tabular-nums;color:var(--ink-3)}
.rst{display:inline-flex;align-items:center;gap:4px}
.rst i{width:6px;height:6px;border-radius:50%;background:#9aa2b3}
.rchip[data-tone="ok"] .rst i{background:#1fa36a}.rchip[data-tone="warn"] .rst i{background:#e7a034}.rchip[data-tone="bad"] .rst i{background:#e0574c}
.rchip[data-tone="bad"] .rst{color:var(--bad)}
.rrem{font-variant-numeric:tabular-nums;font-weight:600;color:var(--ink)}
`;