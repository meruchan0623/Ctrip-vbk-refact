"""Build request-contract reference documents from sanitized browser evidence.

This tool performs no requests and never turns observed keys into required fields.
"""
from __future__ import annotations

import copy
import json
import re
from collections import defaultdict
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

ROOT = Path(__file__).resolve().parents[2]
API = ROOT / 'docs/api'
EVIDENCE = API / 'evidence/2026-10-30'

SOURCES = {
    'groupId': '当前会话 conversation.gid；保留本调用点的原始类型',
    'gid': '当前会话 conversation.gid；不得由客户 UID 或订单号拼造',
    'gidList[]': '需要补查的服务端会话 gid 集合',
    'sessionId': '当前会话 conversation.sessionId / startChatB2C 返回值',
    'worksheetId': '当前会话工作单；与 workSheetId 拼写不同，使用本接口实际类型',
    'workSheetId': '当前会话工作单；邀请提交的序列化类型以实际样本为准',
    'conversationKey': '当前会话 conversation.conversationKey',
    'conversationType': '当前会话 conversation.conversationType',
    'serviceType': '当前会话 conversation.serviceType，不全局硬编码 1513',
    'targetVenAgentUid': '最新成员列表中明确选中的目标 uid；本轮目标 Jim',
    'venAgentUidList[]': '邀请候选 agentInfoList[].agentUid，排除自己与已在群成员',
    'venAgentUids[]': '明确选中的待移除商家成员 uid；空列表必须拒绝',
    'parentSkillGroupIds[]': '上一层候选响应 skillGroupList[].skillGroupId',
    'vendorId': '当前会话或当前登录供应商身份，不能接受未核对的外部覆盖',
    'vendorRefId': '已授权会话/官方订单联系入口所给供应商引用',
    'customerUid': '已授权当前会话客户 uid；只凭 UID 不构成新建会话授权',
    'uid': '调用上下文决定的身份字段；需结合本接口业务调用点核对，不能与坐席 UID 混用',
    'uidList[]': '待补全资料的成员 uid 列表',
    'threadId': '当前会话 threadId',
    'orderId': '当前受控会话关联订单 / 官方订单入口，保留字符串',
    'ttdOrderId': '本账号授权可见的完整订单号，保留字符串',
    'OrderDetailsRequestDTO.orderId': '当前会话 ext.orderId / ext.orderid，保留字符串',
    'languageInfo': '当前会话语言上下文；完整子结构见本接口样本',
    'extParams': '官方会话或联系入口返回的 ext；完整透传结构见样本，票据必须取当前值',
    'beginTime': '已读取消息边界 createTime；与 direction=next 配对，不能混用结束边界',
    'endTime': '已读取消息边界 createTime；与 direction=prev 配对',
    'beginMsgTime': 'SDK 最近消息游标/lastMessageTimestamp；不能每次重置造成重复补拉',
    'lastMsgTime': '通知增量游标，来自上一响应',
    'lastUpdateTime': '会话列表上一轮服务端返回的增量游标',
    'searchValue': '页面输入；本轮为指定受控会话搜索或已授权转移会话搜索',
    'keywords': '邀请弹窗搜索输入，本轮 Jim',
    'queryValue': '产品推荐搜索框输入',
    'locale': '当前页面/账号语言；不要替换成客户语言',
    'channel': '具体上传链路/调用点常量，图片 im_business 与普通文件 im 分开',
    'type': '具体调用点协议枚举；不能跨接口套用',
    'head': '该接口所属请求层生成；见 authentication.md 两类 head',
    'head.cid': '公共请求层补入的客户端标识；具体合并来源尚需逐调用点核实',
    'head.sid': '公共请求层补入的字段；不可将单次样本推定为全局常量',
    'head.auth': '本轮 Cookie 请求为空；显式 token 分支与 Cookie 分支分开',
    'head.extension[].name': '对应 head 配置的准确名称，protocol 与 protocal 不同',
    'head.extension[].value': '对应协议扩展的实际常量或运行时上下文，见完整示例与鉴权文档',
    'role': '官方会话/订单联系入口的 vendorRole；只使用原入口授权的值',
    'chatType': '当前调用点的单聊/群聊映射；不要直接用 B2C 替换 SDK 群聊枚举',
    'messageId': '当前群内消息的服务端 msgId；不能把本地 localId 当成 msgId',
    'messageIdList[]': '当前待翻译消息的服务端 msgId 集合',
    'partnerId': '主包撤回调用使用消息 fromGid || toJid；不是任意客户 UID',
    'partnerJid': '官方 SDK 根据当前群聊/单聊目标生成；保持本接口格式',
    'venAgentUid': '当前登录客服身份，不接受其他坐席 UID 替换当前身份',
    'startTime': '会话列表上一响应 lastUpdateTime，按当前网页增量调用点传递',
    'content': '本接口快捷回复查询的当前编辑器片段；不等同消息发送接口',
    'messageBody': 'SDK 序列化的消息体；文本与媒体 JSON 字符串分开，见 transports.md',
    'localId': 'SDK 为本次发送生成的本地关联标识；本轮不证明全场景幂等',
    'localTimeStamp': 'SDK 本次发送的客户端时间；保持原始数字类型',
    'resource': '当前 SDK 的运行环境/资源标识；由官方 SDK 生成',
    'msgType': 'SDK 当前消息类别；与 WS 的字符串 msgtype 按各自类型处理',
    'contentType': '公共 SOA 包装层的 body 字段；不能替代 HTTP Content-Type',
}
FIXED = {'pageIndex','pageNo','pageSize','needTodoList','direction','showTargetIsRead',
         'action','inSession','senderRole','platformId','requestType','queryType',
         'decryptType','automaticTranslation','searchType','categoryType','typeList[]'}


def dump(value):
    return json.dumps(value, ensure_ascii=False, indent=2)


def normalize(path):
    return re.sub(r'\[\d+\]', '[]', path)


def fields(value, schema, path=''):
    kind = schema.get('type', 'unknown')
    yield path or '(body)', kind, value
    if kind == 'object':
        for key, sub in schema.get('properties', {}).items():
            child = value.get(key) if isinstance(value, dict) else None
            yield from fields(child, sub, f'{path}.{key}' if path else key)
    elif kind == 'array':
        sub = schema.get('items', {})
        variants = sub.get('anyOf', [sub])
        for i, variant in enumerate(variants):
            yield from fields(value[min(i,len(value)-1)] if isinstance(value,list) and value else None,
                              variant, path+'[]')
    if schema.get('encodedJson'):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            parsed = None
        yield from fields(parsed, schema['encodedJson'], path+'(JSON字符串)')


def source(path, value):
    key = normalize(path)
    if key in SOURCES:
        return SOURCES[key]
    if key.startswith('head.'):
        return '对应请求层的公共 head；见 authentication.md，不与 HTTP Header 合并'
    if key.startswith('extParams.'):
        return '已授权当前会话 extParams 同名字段；动态票据不得复用旧值'
    if key.startswith('languageInfo.'):
        return '当前会话 languageInfo 同名字段'
    if key in FIXED:
        return '实际调用点配置/用户操作；本轮观测值见完整示例，非已证明的完整枚举'
    if isinstance(value, str) and value.startswith('{{'):
        return '待追溯：当前仅保留位置与类型，来源未闭环，阻塞自行构造请求'
    return '本轮实际观测值；必填性、默认值及完整取值范围未由单次样本证明'


def headers_table(headers):
    grouped = {}
    for key, value in headers.items():
        grouped.setdefault(key.lower(), value)
    lines = ['| Header | 本轮值/占位符 | 生成方 |', '| --- | --- | --- |']
    for key, value in sorted(grouped.items()):
        if key.startswith(':'):
            who = 'HTTP/2 传输层伪头；不写入应用 fetch headers'
        elif key in {'cookie','origin','referer','host','user-agent','content-length','accept-encoding','accept-language','priority'} or key.startswith('sec-'):
            who = '浏览器/网络栈；复用当前 Profile，不手工设置受限头'
        elif key in {'authorization','content-md5'}:
            who = '当前上传适配器；见 authentication.md'
        elif key in {'w-payload-source','x-ctx-wclient-req'} or key.startswith('x-ctx-ubt'):
            who = '平台公共请求/风控/埋点层；动态生成，算法未全部闭环'
        else:
            who = '对应业务请求层/SDK；以本接口实际值为准'
        lines.append(f'| `{key}` | `{str(value).replace("|", "&#124;")}` | {who} |')
    return '\n'.join(lines)


def main():
    groups = defaultdict(list)
    for file in sorted(EVIDENCE.glob('*.json')):
        data = json.loads(file.read_text())
        if not isinstance(data,dict):
            continue
        for raw in data.get('requests', []):
            if raw.get('method') == 'OPTIONS':
                continue
            r = copy.deepcopy(raw)
            u = urlsplit(r['url'])
            r['evidence'] = str(file.relative_to(API))
            r['queryTemplate'] = dict(parse_qsl(u.query, keep_blank_values=True))
            # Recover protocol extension constants already recorded separately.
            if isinstance(r.get('requestTemplate'),dict) and r.get('headExtension'):
                r['requestTemplate'].setdefault('head', {})['extension'] = r['headExtension']
            observer = next((x for x in data.get('xhr',[]) if x['method']==r['method'] and x['url']==r['url']),None)
            if observer:
                r['xhrEvidence'] = observer
                if observer.get('payload',{}).get('kind') in {'File','Blob'}:
                    r['requestEncoding'] = 'raw binary (File/Blob), not multipart'
                    r['requestTemplate'] = {'binaryFile':observer['payload']}
                    r['requestSchema'] = {'type':'string','contentMediaType':observer['payload'].get('type'),'x-binary-file':True}
                if r.get('responseSchema',{}).get('type') == 'undefined':
                    r['responseTemplate'] = observer['response']
                    r['responseSchema'] = observer['responseSchema']
                    r['responseSource'] = 'same-action XHR loadend observer (CDP body unavailable)'
            key = (u.netloc,u.path,r['method'])
            groups[key].append(r)

    target = API / 'endpoints'
    target.mkdir(exist_ok=True, parents=True)
    catalog=[]
    for (host,path,method), samples in sorted(groups.items()):
        name = host+'-'+path.removeprefix('/restapi/soa2/').strip('/').replace('/','-')+'-'+method.lower()
        def variant_key(r):
            response=r.get('responseTemplate')
            status=response.get('ResponseStatus',{}) if isinstance(response,dict) else {}
            outcome={'http':r.get('httpStatus'),'ack':status.get('Ack'),
                     'errors':status.get('Errors'),
                     'business':response.get('bizResponseStatus') if isinstance(response,dict) else None,
                     'status':response.get('status') if isinstance(response,dict) else None,
                     'responseKeys':list(response) if isinstance(response,dict) else None}
            # Preserve authentication, failure and observed response-shape branches.
            return json.dumps([r.get('requestTemplate'),r.get('queryTemplate'),
                               {k.lower():v for k,v in r.get('requestHeaders',{}).items()},
                               r.get('extraInfoObserved'),outcome],sort_keys=True)
        variants = list({variant_key(r):r for r in samples}.values())
        variants.sort(key=lambda r:(r.get('responseTemplate',{}).get('ResponseStatus',{}).get('Ack')!='Success' if isinstance(r.get('responseTemplate'),dict) else False, not r.get('extraInfoObserved'),r.get('requestSchema',{}).get('type')=='undefined'))
        best=variants[0]
        unknown=[]
        rows={}
        for r in variants:
            for key,typ,value in fields(r.get('requestTemplate'),r.get('requestSchema',{})):
                src=source(key,value)
                rows[(key,typ)]=src
                if src.startswith('待追溯:') or src.startswith('待追溯：'):
                    unknown.append(key)
        entry={'host':host,'path':path,'method':method,'samples':len(samples),'requestVariants':variants,
               'fieldSources':[{ 'path':key,'type':typ,'source':src} for (key,typ),src in rows.items()],
               'unresolvedFieldSources':sorted(set(unknown)),
               'requestElementsCaptured':any(bool(r.get('requestHeaders') and r.get('extraInfoObserved') and r.get('requestSchema',{}).get('type')!='undefined') for r in samples),
               'implementationReady':False,
               'readinessReason':'完整请求观测不等于字段来源、失败分支和目标宿主均验证；全项目准入保持关闭',
               'document':f'endpoints/{name}.md'}
        leaf=path.rsplit('/',1)[-1]
        if leaf in {'getTimeZoneList','getWordsAboves'}:
            scope='头像设置只读旁证；用户已要求本轮不继续'
        elif leaf in {'saveLogInfo','createTUid','queryCountByEid','getDoorFunctionGuide','getProviderBusinessLineList','ContactUs','generateWaterMark','searchPop','queryevent'}:
            scope='页面自动辅助请求；不扩展为本项目功能'
        elif '/14361/' in path and leaf not in {'searchorderlist','createimchat'}:
            scope='官方订单详情页内部读取旁证；不恢复完整订单管理'
        else:
            scope='网页消息/身份/联系入口及共享读取契约'
        entry['scope']=scope
        catalog.append(entry)
        body=[f'# {method} {host}{path}', '',
              '状态：真实网页请求样本；完整实施准入尚未通过。固定网页版本、鉴权边界和占位符规则见 [鉴权说明](../authentication.md)。', '',
              f'- 完整地址：`https://{host}{path}`',f'- 请求方法：`{method}`',f'- 范围：{scope}',
              f'- 编码：{best.get("requestEncoding", "JSON；HTTP Content-Type 见下表，不能由 body.contentType 推断")}',
              f'- Authentication：{"该上传链路独立处理，见鉴权说明与本次实际头；不得套 SOA Cookie 模板" if "nephele" in host else "本轮浏览器 Cookie 会话；逐项 Cookie 必需性未证明，见鉴权说明"}',
              f'- 原始证据：'+ '、'.join(f'[{p}]({"../"+p})' for p in sorted({r['evidence'] for r in samples})), '',
              '## HTTP 请求 Header', '', headers_table(best['requestHeaders']), '',
              '以上为观察到的请求头，包含 CDP ExtraInfo。出现不代表逐项必需；浏览器自动字段、风控字段和应用字段分开处理。', '',
              '## Query 参数', '', '```json',dump(best.get('queryTemplate',{})),'```','',
              '`_fxpcqlniredt`、`x-traceID` 如出现，由平台公共请求层处理；nonce、时间戳和上传 rand 不可复制为常量。', '',
              '## 完整请求样本与分支', '',
              '`{{字段路径:类型}}` 是脱敏占位符，不能作为字面量发出。数字占位符的原始类型以参数表为准。数组不截断；JSON 字符串仍保留字符串编码。']
        for i,r in enumerate(variants,1):
            response=r.get('responseTemplate')
            ack=response.get('ResponseStatus',{}).get('Ack') if isinstance(response,dict) else None
            body += ['',f'### 样本 {i}：{r["stage"]} / HTTP {r.get("httpStatus","未获取")} / Ack {ack or "本链路无该字段或未获取"}', '']
            if r.get('requestSchema',{}).get('type')=='undefined':
                body += ['该次请求体未取得，不能作为可发送样本。完整样本见本页其他分支；该不完整观测仍保留在证据。']
            else:
                body += ['```json',dump(r.get('requestTemplate')),'```']
            if ack and ack!='Success':
                body += ['', '该失败分支响应：', '', '```json',dump(response),'```']
        body += ['', '## 参数类型与来源', '', '| 位置 | 实测类型 | 来源与限制 |','| --- | --- | --- |']
        for (key,typ),src in rows.items():
            body.append(f'| `{key}` | `{typ}` | {src} |')
        body += ['', '“观测到”不等于“必填”。本轮未进行完整删字段/边界矩阵，不编造 required、默认值、枚举或省略行为。', '',
                 '## 响应与读回', '',
                 '完整响应结构和脱敏实例在以上证据的 responseSchema / responseTemplate；上传另有 xhr.response。HTTP 200、Ack Success 和最终业务状态分别判断。', '',
                 '```json',dump(best.get('responseTemplate')),'```','',
                 '写请求未知结果先读回，不自动重发。具体 UI 操作、目标和状态收敛见 [验证记录](../validation.md)。', '',
                 '## 未完成项', '',
                 '- 逐字段必填性、所有条件分支和失败范围尚未穷尽。',
                 '- 独立宿主 Origin/Profile/网络层尚未验证；页面内重放成功不能外推到原生 HTTP。',
                 '- 动态来源未闭环：'+('、'.join(f'`{x}`' for x in sorted(set(unknown))) or '见公共 head / 风控 / 身份来源的共同未完成项。'), '']
        (target/(name+'.md')).write_text('\n'.join(body))

    (API/'catalog.json').write_text(dump({'generatedFrom':'sanitized ego-browser CDP + same-action XHR evidence','endpoints':catalog})+'\n')
    index=['# 接口请求契约', '', '2026-10-30，Asia/Singapore。**当前仅采集、整理与验证契约，业务实现准入保持关闭。**', '',
           '用户要求拿到所有必要请求要素后才开始开发。本目录替代历史材料中“仅有路由和业务字段”的实施入口，历史调查仍保留事实与时点。', '',
           '- [Authentication、公共 Header 与两类 head](authentication.md)',
           '- [WebSocket、HTTP 兜底与侧栏文档](transports.md)',
           '- [TSim 登录、翻译与套餐查询源码契约](external-tsim.md)',
           '- [真实操作与读回记录](validation.md)',
           '- [开发准入与剩余缺项](readiness.md)',
           '- [逐接口机器目录及全部样本](catalog.json)',
           '- [旧证据接口清点](inventory.json)', '',
           f'本轮实际采集 **{len(catalog)} 个 HTTP method + host + path 组合**，其中 {sum(x["requestElementsCaptured"] for x in catalog)} 个至少有一份请求头、ExtraInfo 与请求结构齐全的样本。该数字不等于接口已全部验证或可开始开发。OPTIONS 保留在证据中，不计业务接口。', '',
           '用户最新要求：头像内设置本轮不再继续采集；已有只读旁证保留，不列为本轮补齐阻塞。接口行中的自动辅助请求和官方订单页内部读取不构成新增功能范围。', '',
           '| 方法 | Host / Path | 样本 | 请求要素观测 | 范围 |', '| --- | --- | --- | --- | --- |']
    for c in catalog:
        index.append(f'| {c["method"]} | [{c["host"]}{c["path"]}]({c["document"]}) | {c["samples"]} | {"有完整请求形态样本" if c["requestElementsCaptured"] else "仍缺请求体/ExtraInfo"} | {c["scope"]} |')
    index += ['', '占位符保留动态位置与原始类型；`dynamic_ref_*` 是动态字典键的不可逆脱敏引用，不是固定字段。同一采集文件内可对应，不跨动作强行关联。证据 schema 是观测描述，不是推定 required 的 OpenAPI 声明。', '',
              '采集 stage 表示观察窗口；初始化、后台同步与埋点可能混入。动作验收以对应主请求、当前目标校验及业务/UI 读回为准，不把该窗口全部请求都解释成用户动作。', '',
              '本轮新网页主包版本为 `1793340371237`，业务逻辑位于 `296-1776b2655d6f3342.js`；SDK 为 `imsdk.850ee19f2122897fcb3d3d18f17bc8d4.js`。旧版本 `1792569719501` 的材料不能未经核对直接作为当前契约。', '']
    (API/'README.md').write_text('\n'.join(index))
    print(json.dumps({'endpoints':len(catalog),'fullObservedSamples':sum(c['requestElementsCaptured'] for c in catalog),'businessImplementationAllowed':False},ensure_ascii=False))


if __name__ == '__main__':
    main()
