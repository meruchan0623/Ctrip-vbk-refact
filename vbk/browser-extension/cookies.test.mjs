import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCookies } from './cookies.js';
const fixture = {domain:'.ctrip.com',name:'bticket',value:'synthetic',path:'/',secure:true,httpOnly:true,hostOnly:false,sameSite:'lax'};
test('only eligible authentication cookies are exported', () => {
 const rejected=[{domain:'.evil.test'},{name:'tracking'},{hostOnly:true},{path:'/other'},{secure:false},{partitionKey:{topLevelSite:'https://other.test'}},{value:'x;y'},{expirationDate:1}].map(p=>({...fixture,...p}));
 const output=selectCookies([fixture,...rejected],10);
 assert.equal(output.length,1); assert.equal(output[0].http_only,true); assert.equal(output[0].expiration,null);
});
test('host-only vbooking is accepted and preserves expiry',()=>{
 const result=selectCookies([{...fixture,domain:'vbooking.ctrip.com',hostOnly:true,expirationDate:100.9}],10);
 assert.equal(result[0].expiration,100);assert.equal(result[0].host_only,true);
});
