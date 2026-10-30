"""Read-only privacy and structure audit for this task's sanitized evidence."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
DIRECTORY=ROOT/'docs/api/evidence/2026-10-30'
PRIVATE=re.compile(r'^(?:\d{12,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|_ti[a-z0-9_]+|csm\d+)$',re.I)
EXT={'protocol','protocal','cpc','appid','language','amp-product-type','amp-account-source','client-source','locale'}


def main():
    failures=[]
    pairs=0
    incomplete=0
    def fail(file,path,reason):
        safe_path=re.sub(r'\d{12,}|_ti[a-z0-9_]+|csm\d+','[redacted-key]',path,flags=re.I)
        failures.append({'file':file.name,'path':safe_path,'reason':reason})
    def matches(value,shape):
        kind=shape.get('type')
        if isinstance(value,str) and value.startswith('{{'):
            typed=re.search(r':(number|string|boolean|object|array|null)\}\}$',value)
            return not typed or typed.group(1)==kind
        if kind=='object':
            return isinstance(value,dict) and set(value)==set(shape.get('properties',{})) and all(matches(v,shape['properties'][k]) for k,v in value.items())
        if kind=='array':
            sub=shape.get('items',{})
            return isinstance(value,list) and len(value)==shape.get('observedLength') and all(any(matches(v,s) for s in sub.get('anyOf',[sub])) for v in value)
        if kind=='number':return isinstance(value,(int,float)) and not isinstance(value,bool)
        if kind=='string':
            if not isinstance(value,str):return False
            encoded=shape.get('encodedJson')
            if encoded:
                try:return matches(json.loads(value),encoded)
                except ValueError:return False
            if value.startswith(('{','[')):
                try:json.loads(value);return False
                except ValueError:pass
            return True
        if kind=='boolean':return isinstance(value,bool)
        if kind=='null':return value is None
        return kind in {None,'undefined'}
    def structure(value,shape,file,path):
        nonlocal pairs,incomplete
        pairs+=1
        kind=shape.get('type')
        if kind in {None,'undefined'}:
            incomplete+=1
            return
        if isinstance(value,str) and value.startswith('{{'):
            return
        if kind=='object':
            if not isinstance(value,dict):
                fail(file,path,'object template type mismatch');return
            if set(value)!=set(shape.get('properties',{})) or set(value)!=set(shape.get('observedKeys',[])):
                fail(file,path,'template/schema keys disagree')
            for key,child in value.items():
                structure(child,shape.get('properties',{}).get(key,{}),file,path+'.'+key)
        elif kind=='array':
            if not isinstance(value,list):
                fail(file,path,'array template type mismatch');return
            if len(value)!=shape.get('observedLength'):
                fail(file,path,'observed array length changed')
            sub=shape.get('items',{})
            if sub.get('type'):
                for i,item in enumerate(value):structure(item,sub,file,path+f'[{i}]')
            else:
                for i,item in enumerate(value):
                    candidate=next((s for s in sub.get('anyOf',[]) if matches(item,s)),None)
                    if candidate is None:fail(file,path+f'[{i}]','no matching observed array-item schema')
                    else:structure(item,candidate,file,path+f'[{i}]')
        elif kind=='string':
            if not isinstance(value,str):
                fail(file,path,'string template type mismatch')
            elif shape.get('encodedJson'):
                try:structure(json.loads(value),shape['encodedJson'],file,path+'.$json')
                except ValueError:fail(file,path,'encoded JSON string is invalid')
        elif kind=='number' and (not isinstance(value,(int,float)) or isinstance(value,bool)):
            fail(file,path,'number original type lost')
        elif kind=='boolean' and not isinstance(value,bool):fail(file,path,'boolean original type lost')
        elif kind=='null' and value is not None:fail(file,path,'null original type lost')
    def walk(value,file,path='root'):
        if isinstance(value,dict):
            for key,child in value.items():
                if PRIVATE.fullmatch(key):fail(file,path,'private dynamic object key')
                walk(child,file,path+'.'+key)
            for template,shape in [('requestTemplate','requestSchema'),('responseTemplate','responseSchema'),('bodyTemplate','bodySchema'),('payload','payloadSchema'),('state','schema')]:
                if template in value and shape in value:structure(value[template],value[shape],file,path+'.'+template)
            if isinstance(value.get('headExtension'),list):
                for i,item in enumerate(value['headExtension']):
                    v=item.get('value')
                    if item.get('name') not in EXT and not (isinstance(v,str) and v.startswith('{{')):
                        fail(file,path+f'.headExtension[{i}].value','non-protocol extension value is not redacted')
            for headerGroup in ['requestHeaders','responseHeaders','headers']:
                h=value.get(headerGroup)
                if isinstance(h,dict):
                    for name,v in h.items():
                        if name.lower() in {'authorization','w-payload-source'} and isinstance(v,str) and not v.startswith('{{'):
                            fail(file,path+'.'+headerGroup+'.'+name,'dynamic header not redacted')
                        if name.lower()=='cookie' and isinstance(v,str):
                            for part in v.split(';'):
                                if '=' in part and not part.split('=',1)[1].strip().startswith('{{'):
                                    fail(file,path+'.'+headerGroup+'.cookie','cookie value not redacted')
        elif isinstance(value,list):
            for i,child in enumerate(value):walk(child,file,path+f'[{i}]')
        elif isinstance(value,str):
            if PRIVATE.fullmatch(value):fail(file,path,'unredacted private identifier scalar')
            if value.startswith(('{','[')):
                try:walk(json.loads(value),file,path+'.$json')
                except ValueError:pass
    files=[p for p in DIRECTORY.glob('*.json') if p.name!='source-anchors.json']
    for file in files:walk(json.loads(file.read_text()),file)
    result={'evidenceFiles':len(files),'templateSchemaNodesChecked':pairs,'unavailableSchemaNodes':incomplete,
            'failureCount':len(failures),'failures':failures[:20],'businessReadinessAsserted':False}
    print(json.dumps(result,ensure_ascii=False,indent=2))
    if failures:raise SystemExit(1)


if __name__=='__main__':main()
