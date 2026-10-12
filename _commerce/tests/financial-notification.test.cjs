'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildOrderMessage,NOTIFICATION_TYPES,buildIdempotencyKey}=require('../src/lib/transactional-order-email.cjs');
const order={email:'owner@example.invalid',publicOrderNumber:'PS-20261012-0024',currency:'USD',total:39.8,items:[]};
const make=(type,facts)=>buildOrderMessage({type,order,facts,from:'shop@example.invalid',messageKey:buildIdempotencyKey(type,'test-id')});
const body=m=>{const p=/Content-Type: text\/plain[^\r\n]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/.exec(m);return Buffer.from(p[1].replace(/\r\n/g,''),'base64').toString('utf8')};
test('refund receipt cannot be rendered from a provisional, unknown or wrong-currency fact',()=>{
 for(const facts of [{verified:false,state:'completed',amount:39.8,currency:'USD'},{verified:true,state:'processing',amount:39.8,currency:'USD'},{verified:true,state:'completed',amount:39.8,currency:'EUR'}])assert.equal(make(NOTIFICATION_TYPES.REFUND_COMPLETED,facts),null);
});
test('cancellation tells the difference between no payment, void and captured pending refund',()=>{
 const base={verified:true,currency:'USD',captured:0,refunded:0,authorization:'none'};
 assert.match(body(make(NOTIFICATION_TYPES.ORDER_CANCELLED,base)),/No payment authorization/);
 assert.match(body(make(NOTIFICATION_TYPES.ORDER_CANCELLED,{...base,authorization:'voided'})),/authorization has been voided/);
 const pending=body(make(NOTIFICATION_TYPES.ORDER_CANCELLED,{...base,captured:39.8}));assert.match(pending,/USD 39\.80/);assert.match(pending,/not yet confirmed/);assert.doesNotMatch(pending,/has been refunded/);
});
test('new financial notifications preserve a stable Message-ID across attempts',()=>{
 const facts={verified:true,currency:'USD',amount:39.7,state:'completed'};
 const a=make(NOTIFICATION_TYPES.REFUND_COMPLETED,facts),b=make(NOTIFICATION_TYPES.REFUND_COMPLETED,facts);
 assert.equal(/Message-ID: (.*)/.exec(a)[1],/Message-ID: (.*)/.exec(b)[1]);assert.match(body(a),/USD 39\.70/);assert.doesNotMatch(body(a),/PayPal|capture_id|authorization_id/);
});
