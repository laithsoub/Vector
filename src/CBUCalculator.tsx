import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Printer, ChevronDown, Copy, Check } from 'lucide-react';

// ── Salesmen from Tables sheet ────────────────────────────────────────────────
const SALESMEN = [
  { name: 'Blair McDonald',  email: 'blairgmcdonald@eaton.com',  phone: '07890954552' },
  { name: 'Craig Donaldson', email: 'craigdonaldson@eaton.com',  phone: '07811692079' },
  { name: 'Joe Bayley',      email: 'joebayley@eaton.com',       phone: '07713325534' },
  { name: 'Mark Fenton',     email: 'MarkAFenton@Eaton.com',     phone: '07713325528' },
  { name: 'Ollie Bailey',    email: 'olliejbailey@eaton.com',    phone: '07866893068' },
  { name: 'Ryan Houston',    email: 'ryanhouston@eaton.com',     phone: '07773949386' },
];

interface Row { label: string; catNo: string; qty: number; price: number; desc: string; productId: string; cabType: string; dims: string; weight: string; }
interface Cfg  { system: string; build: string; duration: string; total: number; rows: Row[];
  // tech brief fields
  kva:number; capW:number; phases:string; supplyV:number; outputA:number; heatKW:number;
  fuseRect:string; fuseBypass:string; inCable:string; outCable:string; fault:string;
  cRear:string; cFront:string; cTop:string;
  ctrlPN:string; ctrlQty:number; parallelQty:number;
  intPN:string; intQty:number; extPN:string; extQty:number|string;
  ctrlType:string; ctrlDims:string; ctrlWeight:string;
  extType:string; extDims:string; extWeight:string; extStrings:string;
  intIncl:string; intSep:string; ventBoost:string; ventFloat:string;
}

// ── Per-size data ─────────────────────────────────────────────────────────────
// rows mirror Sheet rows 9-13 exactly: ctrl cab / parallel kit / expansion kit / int batt / ext batt cab
const mkRow = (label:string,catNo:string,qty:number,price:number,desc:string,productId:string,cabType='',dims='',weight=''):Row =>
  ({label,catNo,qty,price,desc,productId,cabType,dims,weight});

const DATA: Record<string,Cfg> = {
'1PH- 0.5KVA': { system:'1PH- 0.5KVA', build:'No Parallel', duration:'3hr', total:5501.27,
  kva:0.5,capW:475,phases:'Single',supplyV:230,outputA:2.07,heatKW:0.4,fuseRect:'16A',fuseBypass:'16A',inCable:'2.5mm²',outCable:'2.5mm²',fault:'109A',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS1P2KB0',ctrlQty:1,parallelQty:0,intPN:'P-103003010-002',intQty:1,extPN:'N/A',extQty:0,
  ctrlType:'Type A',ctrlDims:'W335 x D750 x H950',ctrlWeight:'67 / 92 kg',extType:'N/A',extDims:'N/A',extWeight:'N/A',extStrings:'N/A',intIncl:'No batteries',intSep:'P-103003010-002 x1',ventBoost:'N/A',ventFloat:'N/A',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS1P2KB0',    1,3953.32,'LoadStar-PS 2KVA 1ph',          'Control Cabinet(s)',       'Type A','950H x 335W x 750D','67 / 92 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 0,0.00,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103002588',   1,157.30, '',                              ''),
    mkRow('Internal batteries Item Code',  'P-103003010-002',1,1390.65,'Kit Internal battery string (32x9AH LL)',   'Internal Batteries',       '','','50 / 60 kg'),
    mkRow('External battery cabinet',      '—',0,0,      '',                              'External Battery Cabinet(s)'),
  ]},
'1PH- 1KVA': { system:'1PH- 1KVA', build:'No Parallel', duration:'3hr', total:7452.6,
  kva:1,capW:950,phases:'Single',supplyV:230,outputA:4.13,heatKW:0.4,fuseRect:'16A',fuseBypass:'16A',inCable:'2.5mm²',outCable:'2.5mm²',fault:'109A',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS1P2KB0',ctrlQty:1,parallelQty:0,intPN:'P-103003010-002',intQty:1,extPN:'P-105000111-002',extQty:1,
  ctrlType:'Type A',ctrlDims:'W335 x D750 x H950',ctrlWeight:'67 / 92 kg',extType:'Sidecar',extDims:'W159 x D750 x H950',extWeight:'103 / 130 kg',extStrings:'1 string (32x9Ah)',intIncl:'No batteries',intSep:'P-103003010-002 x1',ventBoost:'0.630 m³/h',ventFloat:'0.079 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS1P2KB0',    1,3953.32,'LoadStar-PS 2KVA 1ph',          'Control Cabinet(s)',       'Type A','950H x 335W x 750D','67 / 92 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 0,0.00,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103002588',   1,157.30, '',                              ''),
    mkRow('Internal batteries Item Code',  'P-103003010-002',1,1390.65,'Kit Internal battery string (32x9AH LL)',   'Internal Batteries',       '','','50 / 60 kg'),
    mkRow('External battery cabinet',      'P-105000111-002',1,1951.33,'Battery Sidecar 1x32 9AHLL','External Battery Cabinet(s)','Sidecar','950H x 159W x 750D','103 / 130 kg'),
  ]},
'1PH- 2KVA': { system:'1PH- 2KVA', build:'No Parallel', duration:'3hr', total:8961.71,
  kva:2,capW:1900,phases:'Single',supplyV:230,outputA:8.26,heatKW:0.4,fuseRect:'16A',fuseBypass:'16A',inCable:'2.5mm²',outCable:'2.5mm²',fault:'109A',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS1P2KB0',ctrlQty:1,parallelQty:0,intPN:'N/A',intQty:0,extPN:'P-105000041-007',extQty:1,
  ctrlType:'Type A',ctrlDims:'W335 x D750 x H950',ctrlWeight:'67 / 92 kg',extType:'EBC-A',extDims:'W335 x D750 x H1300',extWeight:'328 / 349 kg',extStrings:'3 strings (32x9Ah)',intIncl:'No batteries',intSep:'N/A',ventBoost:'1.889 m³/h',ventFloat:'0.236 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS1P2KB0',    1,3953.32,'LoadStar-PS 2KVA 1ph',          'Control Cabinet(s)',       'Type A','950H x 335W x 750D','67 / 92 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 0,0.00,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103002588',   1,157.30, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000041-007',1,4851.09,'EBC-A-3x32-9AHLL-BB-63A','External Battery Cabinet(s)','EBC-A','1300H x 335W x 750D','328 / 349 kg'),
  ]},
'1PH- 4KVA': { system:'1PH- 4KVA', build:'No Parallel', duration:'3hr', total:12085.06,
  kva:4,capW:3800,phases:'Single',supplyV:230,outputA:16.52,heatKW:0.4,fuseRect:'40A',fuseBypass:'40A',inCable:'10mm²',outCable:'10mm²',fault:'109A',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS1P5KB0',ctrlQty:1,parallelQty:0,intPN:'N/A',intQty:0,extPN:'P-105000084-002',extQty:1,
  ctrlType:'Type A',ctrlDims:'W335 x D750 x H950',ctrlWeight:'67 / 92 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'4.032 m³/h',ventFloat:'0.504 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS1P5KB0',    1,3953.32,'LoadStar-PS 5KVA 1ph',          'Control Cabinet(s)',       'Type A','950H x 335W x 750D','67 / 92 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 0,0.00,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103002588',   1,157.30, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',1,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'1PH- 5KVA': { system:'1PH- 5KVA', build:'No Parallel', duration:'3hr', total:13475.71,
  kva:5,capW:4750,phases:'Single',supplyV:230,outputA:20.65,heatKW:0.4,fuseRect:'40A',fuseBypass:'40A',inCable:'10mm²',outCable:'10mm²',fault:'109A',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS1P5KB0',ctrlQty:1,parallelQty:0,intPN:'P-103003010-002',intQty:1,extPN:'P-105000084-002',extQty:1,
  ctrlType:'Type A',ctrlDims:'W335 x D750 x H950',ctrlWeight:'67 / 92 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'P-103003010-002 x1',ventBoost:'4.032 m³/h',ventFloat:'0.504 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS1P5KB0',    1,3953.32,'LoadStar-PS 5KVA 1ph',          'Control Cabinet(s)',       'Type A','950H x 335W x 750D','67 / 92 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 0,0.00,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103002588',   1,157.30, '',                              ''),
    mkRow('Internal batteries Item Code',  'P-103003010-002',1,1390.65,'Kit Internal battery string (32x9AH LL)',   'Internal Batteries',       '','','50 / 60 kg'),
    mkRow('External battery cabinet',      'P-105000084-002',1,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'1PH- 8KVA': { system:'1PH- 8KVA', build:"2x 4 KVA's", duration:'3hr', total:24432.72,
  kva:8,capW:7600,phases:'Single',supplyV:230,outputA:33.04,heatKW:0.8,fuseRect:'2x40A',fuseBypass:'2x40A',inCable:'2x 10mm²',outCable:'2x 10mm²',fault:'218A',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS1P5KB0',ctrlQty:2,parallelQty:1,intPN:'N/A',intQty:0,extPN:'P-105000084-002',extQty:2,
  ctrlType:'Type A',ctrlDims:'W335 x D750 x H950',ctrlWeight:'67 / 92 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'8.064 m³/h',ventFloat:'1.008 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS1P5KB0',    2,3953.32,'LoadStar-PS 5KVA 1ph',          'Control Cabinet(s)',       'Type A','950H x 335W x 750D','67 / 92 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 1,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103002588',   2,157.30, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',2,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'1PH- 10KVA': { system:'1PH- 10KVA', build:"2x 5 KVA's", duration:'3hr', total:27214.02,
  kva:10,capW:9500,phases:'Single',supplyV:230,outputA:41.30,heatKW:0.8,fuseRect:'2x40A',fuseBypass:'2x40A',inCable:'2x 10mm²',outCable:'2x 10mm²',fault:'218A',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS1P5KB0',ctrlQty:2,parallelQty:1,intPN:'P-103003010-002',intQty:2,extPN:'P-105000084-002',extQty:2,
  ctrlType:'Type A',ctrlDims:'W335 x D750 x H950',ctrlWeight:'67 / 92 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'P-103003010-002 x2',ventBoost:'8.064 m³/h',ventFloat:'1.008 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS1P5KB0',    2,3953.32,'LoadStar-PS 5KVA 1ph',          'Control Cabinet(s)',       'Type A','950H x 335W x 750D','67 / 92 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 1,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103002588',   2,157.30, '',                              ''),
    mkRow('Internal batteries Item Code',  'P-103003010-002',2,1390.65,'Kit Internal battery string (32x9AH LL)',   'Internal Batteries',       '','','50 / 60 kg'),
    mkRow('External battery cabinet',      'P-105000084-002',2,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'1PH- 12KVA': { system:'1PH- 12KVA', build:"3x 4 KVA's", duration:'3hr', total:36780.38,
  kva:12,capW:11400,phases:'Single',supplyV:230,outputA:49.57,heatKW:1.2,fuseRect:'3x40A',fuseBypass:'3x40A',inCable:'3x 10mm²',outCable:'3x 10mm²',fault:'327A',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS1P5KB0',ctrlQty:3,parallelQty:2,intPN:'N/A',intQty:0,extPN:'P-105000084-002',extQty:3,
  ctrlType:'Type A',ctrlDims:'W335 x D750 x H950',ctrlWeight:'67 / 92 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'12.096 m³/h',ventFloat:'1.512 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS1P5KB0',    3,3953.32,'LoadStar-PS 5KVA 1ph',          'Control Cabinet(s)',       'Type A','950H x 335W x 750D','67 / 92 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 2,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103002588',   3,157.30, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',3,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'1PH- 15KVA': { system:'1PH- 15KVA', build:"3x 5 KVA's", duration:'3hr', total:40952.33,
  kva:15,capW:14250,phases:'Single',supplyV:230,outputA:61.96,heatKW:1.2,fuseRect:'3x40A',fuseBypass:'3x40A',inCable:'3x 10mm²',outCable:'3x 10mm²',fault:'327A',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS1P5KB0',ctrlQty:3,parallelQty:2,intPN:'P-103003010-002',intQty:3,extPN:'P-105000084-002',extQty:3,
  ctrlType:'Type A',ctrlDims:'W335 x D750 x H950',ctrlWeight:'67 / 92 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'P-103003010-002 x3',ventBoost:'12.096 m³/h',ventFloat:'1.512 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS1P5KB0',    3,3953.32,'LoadStar-PS 5KVA 1ph',          'Control Cabinet(s)',       'Type A','950H x 335W x 750D','67 / 92 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 2,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103002588',   3,157.30, '',                              ''),
    mkRow('Internal batteries Item Code',  'P-103003010-002',3,1390.65,'Kit Internal battery string (32x9AH LL)',   'Internal Batteries',       '','','50 / 60 kg'),
    mkRow('External battery cabinet',      'P-105000084-002',3,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'1PH- 16KVA': { system:'1PH- 16KVA', build:"4x 4 KVA's", duration:'3hr', total:49128.04,
  kva:16,capW:15200,phases:'Single',supplyV:230,outputA:66.09,heatKW:1.6,fuseRect:'4x40A',fuseBypass:'4x40A',inCable:'4x 10mm²',outCable:'4x 10mm²',fault:'436A',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS1P5KB0',ctrlQty:4,parallelQty:3,intPN:'N/A',intQty:0,extPN:'P-105000084-002',extQty:4,
  ctrlType:'Type A',ctrlDims:'W335 x D750 x H950',ctrlWeight:'67 / 92 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'16.128 m³/h',ventFloat:'2.016 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS1P5KB0',    4,3953.32,'LoadStar-PS 5KVA 1ph',          'Control Cabinet(s)',       'Type A','950H x 335W x 750D','67 / 92 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 3,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103002588',   4,157.30, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',4,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'1PH- 20KVA': { system:'1PH- 20KVA', build:"4x 5 KVA's", duration:'3hr', total:54690.64,
  kva:20,capW:19000,phases:'Single',supplyV:230,outputA:82.61,heatKW:1.6,fuseRect:'4x40A',fuseBypass:'4x40A',inCable:'4x 10mm²',outCable:'4x 10mm²',fault:'436A',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS1P5KB0',ctrlQty:4,parallelQty:3,intPN:'P-103003010-002',intQty:4,extPN:'P-105000084-002',extQty:4,
  ctrlType:'Type A',ctrlDims:'W335 x D750 x H950',ctrlWeight:'67 / 92 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'P-103003010-002 x4',ventBoost:'16.128 m³/h',ventFloat:'2.016 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS1P5KB0',    4,3953.32,'LoadStar-PS 5KVA 1ph',          'Control Cabinet(s)',       'Type A','950H x 335W x 750D','67 / 92 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 3,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103002588',   4,157.30, '',                              ''),
    mkRow('Internal batteries Item Code',  'P-103003010-002',4,1390.65,'Kit Internal battery string (32x9AH LL)',   'Internal Batteries',       '','','50 / 60 kg'),
    mkRow('External battery cabinet',      'P-105000084-002',4,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'3PH- 6KVA': { system:'3PH- 6KVA', build:'No Parallel', duration:'3hr', total:14939.15,
  kva:6,capW:5700,phases:'Three',supplyV:400,outputA:14.25,heatKW:0.6,fuseRect:'3x25A',fuseBypass:'3x25A',inCable:'(4C)4mm²',outCable:'(4C)4mm²',fault:'54A/ph',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P10KB2',ctrlQty:1,parallelQty:0,intPN:'Included',intQty:0,extPN:'P-105000084-002',extQty:1,
  ctrlType:'Type B',ctrlDims:'W335 x D750 x H1300',ctrlWeight:'252 / 273 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'2 strings (32x9Ah)',intSep:'Included in unit',ventBoost:'4.032 m³/h',ventFloat:'0.504 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P10KB2',    1,6712.81,'LoadStar-PS 10KVA 3ph',          'Control Cabinet(s)',       'Type B','1300H x 335W x 750D','252 / 273 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 0,0.00,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   1,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',1,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'3PH- 8KVA': { system:'3PH- 8KVA', build:'No Parallel', duration:'3hr', total:21048.98,
  kva:8,capW:7600,phases:'Three',supplyV:400,outputA:19.00,heatKW:0.6,fuseRect:'3x25A',fuseBypass:'3x25A',inCable:'(4C)4mm²',outCable:'(4C)4mm²',fault:'54A/ph',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P10KB0',ctrlQty:1,parallelQty:0,intPN:'N/A',intQty:0,extPN:'P-105000084-002',extQty:2,
  ctrlType:'Type B',ctrlDims:'W335 x D750 x H1300',ctrlWeight:'90 / 111 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'8.064 m³/h',ventFloat:'1.008 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P10KB0',    1,4848.20,'LoadStar-PS 10KVA 3ph',          'Control Cabinet(s)',       'Type B','1300H x 335W x 750D','90 / 111 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 0,0.00,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   1,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',2,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'3PH- 10KVA': { system:'3PH- 10KVA', build:'No Parallel', duration:'3hr', total:22913.59,
  kva:10,capW:9500,phases:'Three',supplyV:400,outputA:23.75,heatKW:0.6,fuseRect:'3x25A',fuseBypass:'3x25A',inCable:'(4C)4mm²',outCable:'(4C)4mm²',fault:'54A/ph',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P10KB2',ctrlQty:1,parallelQty:0,intPN:'Included',intQty:0,extPN:'P-105000084-002',extQty:2,
  ctrlType:'Type B',ctrlDims:'W335 x D750 x H1300',ctrlWeight:'252 / 273 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'2 strings (32x9Ah)',intSep:'Included in unit',ventBoost:'8.064 m³/h',ventFloat:'1.008 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P10KB2',    1,6712.81,'LoadStar-PS 10KVA 3ph',          'Control Cabinet(s)',       'Type B','1300H x 335W x 750D','252 / 273 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 0,0.00,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   1,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',2,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'3PH- 12KVA': { system:'3PH- 12KVA', build:'No Parallel', duration:'3hr', total:31483.08,
  kva:12,capW:11400,phases:'Three',supplyV:400,outputA:28.50,heatKW:1.3,fuseRect:'3x50A',fuseBypass:'3x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'108A/ph',cRear:'250mm',cFront:'500mm',cTop:'650mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:1,parallelQty:0,intPN:'N/A',intQty:0,extPN:'P-105000084-002',extQty:3,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'12.096 m³/h',ventFloat:'1.512 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    1,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 0,0.00,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   1,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',3,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'3PH- 14KVA': { system:'3PH- 14KVA', build:'No Parallel', duration:'3hr', total:36225.48,
  kva:14,capW:13300,phases:'Three',supplyV:400,outputA:33.25,heatKW:1.3,fuseRect:'3x50A',fuseBypass:'3x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'108A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:1,parallelQty:0,intPN:'N/A',intQty:0,extPN:'P-105000017-004',extQty:3,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-C',extDims:'W585 x D914 x H1876',extWeight:'795 / 822 kg',extStrings:'1 string (36xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'13.608 m³/h',ventFloat:'1.701 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    1,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 0,0.00,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   1,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000017-004',3,9555.24,'EBC-C-1x36-CSBHRL12200W-BB-200A-M6','External Battery Cabinet(s)','EBC-C','1876H x 585W x 914D','795 / 822 kg'),
  ]},
'3PH- 16KVA': { system:'3PH- 16KVA', build:'No Parallel', duration:'3hr', total:37996.89,
  kva:16,capW:15200,phases:'Three',supplyV:400,outputA:38.00,heatKW:1.3,fuseRect:'3x50A',fuseBypass:'3x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'108A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:1,parallelQty:0,intPN:'N/A',intQty:0,extPN:'P-105000017-010',extQty:3,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-C',extDims:'W585 x D914 x H1876',extWeight:'865 / 892 kg',extStrings:'1 string (40xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'15.120 m³/h',ventFloat:'1.890 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    1,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 0,0.00,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   1,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000017-010',3,10145.71,'EBC-C-1x40-CSBHRL12200W-BB-200A-M6','External Battery Cabinet(s)','EBC-C','1876H x 585W x 914D','865 / 892 kg'),
  ]},
'3PH- 18KVA': { system:'3PH- 18KVA', build:'No Parallel', duration:'3hr', total:39457.52,
  kva:18,capW:17100,phases:'Three',supplyV:400,outputA:42.75,heatKW:1.3,fuseRect:'3x50A',fuseBypass:'3x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'108A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:1,parallelQty:0,intPN:'N/A',intQty:0,extPN:'P-105000084-002',extQty:4,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'24.192 m³/h',ventFloat:'3.024 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    1,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 0,0.00,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   1,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',6,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'3PH- 20KVA': { system:'3PH- 20KVA', build:'No Parallel', duration:'3hr', total:45780.72,
  kva:20,capW:19000,phases:'Three',supplyV:400,outputA:47.50,heatKW:1.3,fuseRect:'3x50A',fuseBypass:'3x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'108A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:1,parallelQty:0,intPN:'N/A',intQty:0,extPN:'P-105000017-004',extQty:4,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-C',extDims:'W585 x D914 x H1876',extWeight:'795 / 822 kg',extStrings:'1 string (36xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'18.144 m³/h',ventFloat:'2.268 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    1,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 0,0.00,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   1,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000017-004',4,9555.24,'EBC-C-1x36-CSBHRL12200W-BB-200A-M6','External Battery Cabinet(s)','EBC-C','1876H x 585W x 914D','795 / 822 kg'),
  ]},
'3PH- 24KVA': { system:'3PH- 24KVA', build:"2x12 KVA's", duration:'3hr', total:63228.76,
  kva:24,capW:22800,phases:'Three',supplyV:400,outputA:57.00,heatKW:2.6,fuseRect:'6x50A',fuseBypass:'6x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'216A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:2,parallelQty:1,intPN:'N/A',intQty:0,extPN:'P-105000084-002',extQty:6,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'16.128 m³/h',ventFloat:'2.016 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    2,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 1,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   2,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',4,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'3PH- 28KVA': { system:'3PH- 28KVA', build:"2x14 KVA's", duration:'3hr', total:72713.56,
  kva:28,capW:26600,phases:'Three',supplyV:400,outputA:66.50,heatKW:2.6,fuseRect:'6x50A',fuseBypass:'6x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'216A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:2,parallelQty:1,intPN:'N/A',intQty:0,extPN:'P-105000017-004',extQty:6,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-C',extDims:'W585 x D914 x H1876',extWeight:'795 / 822 kg',extStrings:'1 string (36xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'27.216 m³/h',ventFloat:'3.402 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    2,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 1,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   2,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000017-004',6,9555.24,'EBC-C-1x36-CSBHRL12200W-BB-200A-M6','External Battery Cabinet(s)','EBC-C','1876H x 585W x 914D','795 / 822 kg'),
  ]},
'3PH- 30KVA': { system:'3PH- 30KVA', build:"3x 10 KVA's", duration:'3hr', total:69265.97,
  kva:30,capW:28500,phases:'Three',supplyV:400,outputA:71.25,heatKW:1.8,fuseRect:'9x25A',fuseBypass:'9x25A',inCable:'(4C)4mm²',outCable:'(4C)4mm²',fault:'324A/ph',cRear:'150mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P10KB2',ctrlQty:3,parallelQty:2,intPN:'Included',intQty:0,extPN:'P-105000084-002',extQty:6,
  ctrlType:'Type B',ctrlDims:'W335 x D750 x H1300',ctrlWeight:'252 / 273 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'2 strings (32x9Ah)',intSep:'Included in unit',ventBoost:'24.192 m³/h',ventFloat:'3.024 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P10KB2',    3,6712.81,'LoadStar-PS 10KVA 3ph',          'Control Cabinet(s)',       'Type B','1300H x 335W x 750D','252 / 273 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 2,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   3,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',6,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'3PH- 32KVA': { system:'3PH- 32KVA', build:"2x 16 KVA's", duration:'3hr', total:76256.38,
  kva:32,capW:30400,phases:'Three',supplyV:400,outputA:76.00,heatKW:2.6,fuseRect:'6x50A',fuseBypass:'6x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'216A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:2,parallelQty:1,intPN:'N/A',intQty:0,extPN:'P-105000017-010',extQty:6,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-C',extDims:'W585 x D914 x H1876',extWeight:'865 / 892 kg',extStrings:'1 string (40xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'30.240 m³/h',ventFloat:'3.780 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    2,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 1,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   2,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000017-010',6,10145.71,'EBC-C-1x40-CSBHRL12200W-BB-200A-M6','External Battery Cabinet(s)','EBC-C','1876H x 585W x 914D','865 / 892 kg'),
  ]},
'3PH- 36KVA': { system:'3PH- 36KVA', build:"2x 18 KVA's", duration:'3hr', total:79177.64,
  kva:36,capW:34200,phases:'Three',supplyV:400,outputA:85.50,heatKW:2.6,fuseRect:'6x50A',fuseBypass:'6x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'216A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:2,parallelQty:1,intPN:'N/A',intQty:0,extPN:'P-105000084-002',extQty:8,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'32.256 m³/h',ventFloat:'4.032 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    2,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 1,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   2,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',8,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'3PH- 40KVA': { system:'3PH- 40KVA', build:"2x 20 KVA's", duration:'3hr', total:91824.04,
  kva:40,capW:38000,phases:'Three',supplyV:400,outputA:95.00,heatKW:2.6,fuseRect:'6x50A',fuseBypass:'6x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'216A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:2,parallelQty:1,intPN:'N/A',intQty:0,extPN:'P-105000017-004',extQty:8,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-C',extDims:'W585 x D914 x H1876',extWeight:'795 / 822 kg',extStrings:'1 string (36xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'36.288 m³/h',ventFloat:'4.536 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    2,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 1,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   2,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000017-004',8,9555.24,'EBC-C-1x36-CSBHRL12200W-BB-200A-M6','External Battery Cabinet(s)','EBC-C','1876H x 585W x 914D','795 / 822 kg'),
  ]},
'3PH- 42KVA': { system:'3PH- 42KVA', build:"3x 14 KVA's", duration:'3hr', total:109201.64,
  kva:42,capW:39900,phases:'Three',supplyV:400,outputA:99.75,heatKW:3.9,fuseRect:'9x50A',fuseBypass:'9x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'324A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:3,parallelQty:2,intPN:'N/A',intQty:0,extPN:'P-105000017-004',extQty:9,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-C',extDims:'W585 x D914 x H1876',extWeight:'795 / 822 kg',extStrings:'1 string (36xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'40.824 m³/h',ventFloat:'5.103 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    3,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 2,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   3,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000017-004',9,9555.24,'EBC-C-1x36-CSBHRL12200W-BB-200A-M6','External Battery Cabinet(s)','EBC-C','1876H x 585W x 914D','795 / 822 kg'),
  ]},
'3PH- 48KVA': { system:'3PH- 48KVA', build:"3x 16 KVA's", duration:'3hr', total:114515.87,
  kva:48,capW:45600,phases:'Three',supplyV:400,outputA:114.00,heatKW:3.9,fuseRect:'9x50A',fuseBypass:'9x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'324A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:3,parallelQty:2,intPN:'N/A',intQty:0,extPN:'P-105000017-010',extQty:9,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-C',extDims:'W585 x D914 x H1876',extWeight:'865 / 892 kg',extStrings:'1 string (40xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'45.360 m³/h',ventFloat:'5.670 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    3,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 2,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   3,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000017-010',9,10145.71,'EBC-C-1x40-CSBHRL12200W-BB-200A-M6','External Battery Cabinet(s)','EBC-C','1876H x 585W x 914D','865 / 892 kg'),
  ]},
'3PH- 54KVA': { system:'3PH- 54KVA', build:"3x 18 KVA's", duration:'3hr', total:118897.76,
  kva:54,capW:51300,phases:'Three',supplyV:400,outputA:128.25,heatKW:3.9,fuseRect:'9x50A',fuseBypass:'9x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'324A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:3,parallelQty:2,intPN:'N/A',intQty:0,extPN:'P-105000084-002',extQty:12,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'48.384 m³/h',ventFloat:'6.048 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    3,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 2,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   3,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',12,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'3PH- 56KVA': { system:'3PH- 56KVA', build:"4x14 KVA's", duration:'3hr', total:145689.72,
  kva:56,capW:53200,phases:'Three',supplyV:400,outputA:133.00,heatKW:5.2,fuseRect:'12x50A',fuseBypass:'12x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'432A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:4,parallelQty:3,intPN:'N/A',intQty:0,extPN:'P-105000017-004',extQty:12,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-C',extDims:'W585 x D914 x H1876',extWeight:'795 / 822 kg',extStrings:'1 string (36xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'54.432 m³/h',ventFloat:'6.804 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    4,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 3,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   4,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000017-004',12,9555.24,'EBC-C-1x36-CSBHRL12200W-BB-200A-M6','External Battery Cabinet(s)','EBC-C','1876H x 585W x 914D','795 / 822 kg'),
  ]},
'3PH- 60KVA': { system:'3PH- 60KVA', build:"3x 20 KVA's", duration:'3hr', total:137867.36,
  kva:60,capW:57000,phases:'Three',supplyV:400,outputA:142.50,heatKW:3.9,fuseRect:'9x50A',fuseBypass:'9x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'324A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:3,parallelQty:2,intPN:'N/A',intQty:0,extPN:'P-105000017-004',extQty:12,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-C',extDims:'W585 x D914 x H1876',extWeight:'795 / 822 kg',extStrings:'1 string (36xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'54.432 m³/h',ventFloat:'6.804 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    3,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 2,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   3,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000017-004',12,9555.24,'EBC-C-1x36-CSBHRL12200W-BB-200A-M6','External Battery Cabinet(s)','EBC-C','1876H x 585W x 914D','795 / 822 kg'),
  ]},
'3PH- 64KVA': { system:'3PH- 64KVA', build:"4x 16 KVA's", duration:'3hr', total:152775.36,
  kva:64,capW:60800,phases:'Three',supplyV:400,outputA:152.00,heatKW:5.2,fuseRect:'12x50A',fuseBypass:'12x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'432A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:4,parallelQty:3,intPN:'N/A',intQty:0,extPN:'P-105000017-010',extQty:12,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-C',extDims:'W585 x D914 x H1876',extWeight:'865 / 892 kg',extStrings:'1 string (40xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'60.480 m³/h',ventFloat:'7.560 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    4,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 3,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   4,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000017-010',12,10145.71,'EBC-C-1x40-CSBHRL12200W-BB-200A-M6','External Battery Cabinet(s)','EBC-C','1876H x 585W x 914D','865 / 892 kg'),
  ]},
'3PH- 72KVA': { system:'3PH- 72KVA', build:"4x 18 KVA's", duration:'3hr', total:158617.88,
  kva:72,capW:68400,phases:'Three',supplyV:400,outputA:171.00,heatKW:5.2,fuseRect:'12x50A',fuseBypass:'12x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'432A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:4,parallelQty:3,intPN:'N/A',intQty:0,extPN:'P-105000084-002',extQty:16,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-B',extDims:'W761 x D750 x H1750',extWeight:'706 / 733 kg',extStrings:'1 string (32xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'64.512 m³/h',ventFloat:'8.064 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    4,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 3,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   4,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000084-002',16,7974.44,'EBC-B-1x32-CSBHRL12200W-BB-63A-M6','External Battery Cabinet(s)','EBC-B','1750H x 761W x 750D','706 / 733 kg'),
  ]},
'3PH- 80KVA': { system:'3PH- 80KVA', build:"4x 20 KVA's", duration:'3hr', total:183910.68,
  kva:80,capW:76000,phases:'Three',supplyV:400,outputA:190.00,heatKW:5.2,fuseRect:'12x50A',fuseBypass:'12x50A',inCable:'(4C)10mm²',outCable:'(4C)10mm²',fault:'432A/ph',cRear:'250mm',cFront:'500mm',cTop:'500mm',
  ctrlPN:'LSPS3P20KB0',ctrlQty:4,parallelQty:3,intPN:'N/A',intQty:0,extPN:'P-105000017-004',extQty:16,
  ctrlType:'Type C',ctrlDims:'W480 x D750 x H1750',ctrlWeight:'208 / 234 kg',extType:'EBC-C',extDims:'W585 x D914 x H1876',extWeight:'795 / 822 kg',extStrings:'1 string (36xHRL12200W)',intIncl:'No batteries',intSep:'N/A',ventBoost:'72.576 m³/h',ventFloat:'9.072 m³/h',
  rows:[
    mkRow('Control cabinet Item code',     'LSPS3P20KB0',    4,7307.86,'LoadStar-PS 20KVA 3ph',          'Control Cabinet(s)',       'Type C','1750H x 480W x 750D','208 / 234 kg'),
    mkRow('External parallel kit',         'P-103000847SP', 3,262.60,      'Kit 93PM External Parallel',    'Kit 93PM External Parallel'),
    mkRow('Connection area expansion kit', 'P-103003732',   4,251.90, '',                              ''),
    mkRow('Internal batteries Item Code',  'N/A',0,0,      '',                              'Internal Batteries'),
    mkRow('External battery cabinet',      'P-105000017-004',16,9555.24,'EBC-C-1x36-CSBHRL12200W-BB-200A-M6','External Battery Cabinet(s)','EBC-C','1876H x 585W x 914D','795 / 822 kg'),
  ]},
};

const cbu18 = DATA['3PH- 18KVA'];
cbu18.ventBoost = '16.128 m³/h';
cbu18.ventFloat = '2.016 m³/h';
cbu18.rows.find(r => r.label === 'External battery cabinet')!.qty = 4;

const cbu24 = DATA['3PH- 24KVA'];
cbu24.ventBoost = '24.192 m³/h';
cbu24.ventFloat = '3.024 m³/h';
cbu24.rows.find(r => r.label === 'External battery cabinet')!.qty = 6;

const SIZES_1PH = ['1PH- 0.5KVA','1PH- 1KVA','1PH- 2KVA','1PH- 4KVA','1PH- 5KVA','1PH- 8KVA','1PH- 10KVA','1PH- 12KVA','1PH- 15KVA','1PH- 16KVA','1PH- 20KVA'];
const SIZES_3PH = ['3PH- 6KVA','3PH- 8KVA','3PH- 10KVA','3PH- 12KVA','3PH- 14KVA','3PH- 16KVA','3PH- 18KVA','3PH- 20KVA','3PH- 24KVA','3PH- 28KVA','3PH- 30KVA','3PH- 32KVA','3PH- 36KVA','3PH- 40KVA','3PH- 42KVA','3PH- 48KVA','3PH- 54KVA','3PH- 56KVA','3PH- 60KVA','3PH- 64KVA','3PH- 72KVA','3PH- 80KVA'];

const f2 = (n:number) => `£${n.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}`;

// ── Dropdown component ────────────────────────────────────────────────────────
const DropdownClose = React.createContext<()=>void>(()=>{});

function Dropdown({label,value,placeholder,children,required}:{label:string;value:string;placeholder:string;children:React.ReactNode;required?:boolean}) {
  const [open,setOpen] = useState(false);
  const ref        = useRef<HTMLDivElement>(null);
  const btnRef     = useRef<HTMLButtonElement>(null);
  const dropRef    = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({top:0,left:0,width:0});

  const close = () => setOpen(false);

  useEffect(()=>{
    const h=(e:MouseEvent)=>{
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !dropRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown',h);
    return ()=>document.removeEventListener('mousedown',h);
  },[]);

  const handleOpen = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + window.scrollY + 4, left: r.left + window.scrollX, width: Math.max(r.width, 220) });
    }
    setOpen(v=>!v);
  };

  return (
    <DropdownClose.Provider value={close}>
      <div ref={ref} className="relative">
        <label className="block text-[10px] font-bold text-zinc-400 uppercase tracking-wide mb-1">
          {label}{required&&<span className="text-red-400 ml-0.5">*</span>}
        </label>
        <button ref={btnRef} onClick={handleOpen}
          className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-xl border bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 hover:border-blue-400 transition-all text-left${open?' border-blue-400 ring-2 ring-blue-100 dark:ring-blue-900/30':''}`}>
          <span className={value?'font-semibold text-zinc-900 dark:text-white':'text-zinc-400'}>{value||placeholder}</span>
          <ChevronDown className={`w-3.5 h-3.5 text-zinc-400 transition-transform shrink-0 ml-1${open?' rotate-180':''}`}/>
        </button>
        {open && createPortal(
          <div ref={dropRef} style={{position:'absolute', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999}}
            className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-2xl overflow-auto max-h-80">
            {children}
          </div>,
          document.body
        )}
      </div>
    </DropdownClose.Provider>
  );
}

// Item inside a Dropdown — calls close via context then runs onClick
function DItem({onClick,active,children}:{onClick:()=>void;active:boolean;children:React.ReactNode}) {
  const close = React.useContext(DropdownClose);
  return (
    <button onClick={()=>{ onClick(); close(); }}
      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors${active?' bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300 font-semibold':''}`}>
      {children}
    </button>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function CBUCalculator() {
  const [size,  setSize]   = useState('');
  const [pn,    setPN]     = useState('');
  const [qr,    setQR]     = useState('');
  const [smIdx, setSmIdx]  = useState<number|null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const cfg = size ? DATA[size] : null;
  const sm  = smIdx !== null ? SALESMEN[smIdx] : null;
  const ok  = !!cfg && !!pn.trim() && !!qr.trim() && sm !== null;

  const ycls = "bg-yellow-50 dark:bg-yellow-900/20 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs font-semibold text-zinc-800 dark:text-zinc-100 rounded";

  const handleExport = async () => {
    if (!ok || !sm) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/run/cbu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system:   size,
          project:  pn.trim(),
          quote:    qr.trim(),
          engineer: sm.name,
          email:    sm.email,
          phone:    sm.phone,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Server error');

      const dl = await fetch(`/api/download/cbu/${json.id}`);
      if (!dl.ok) throw new Error('Download failed');
      const blob = await dl.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `CBU_Tech_Brief_${qr.trim()}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message || 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const [copied, setCopied] = useState<string|null>(null);

  const copy = (val: string, key: string) => {
    navigator.clipboard.writeText(val).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const CopyBtn = ({ val, id }: { val: string; id: string }) => (
    <button onClick={() => copy(val, id)} title="Copy"
      className="ml-1.5 p-0.5 rounded text-zinc-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors shrink-0">
      {copied === id
        ? <Check className="w-3 h-3 text-emerald-500"/>
        : <Copy className="w-3 h-3"/>}
    </button>
  );

  return (
    <div className="space-y-3 max-w-5xl">

      {/* ── Title + Export button ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-zinc-800 dark:text-zinc-100">UK CSO Loadstar-PS Quote Configurator V3</h2>
          <p className="text-[11px] text-zinc-400 mt-0.5">Only edit yellow cells</p>
        </div>
        <button onClick={handleExport} disabled={!ok || loading}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all${ok&&!loading?' bg-blue-600 hover:bg-blue-700 text-white':' bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed'}`}>
          <Printer className="w-3.5 h-3.5"/>
          {loading ? 'Generating…' : ok ? 'Export CBU Tech Brief PDF' : 'Fill all fields to export'}
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-2">
          {error}
        </div>
      )}

      {/* ── System / Build / Duration + Project info — all in one card ────────── */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">

        {/* Row 1: System selector + auto fields */}
        <div className="grid grid-cols-3 bg-zinc-100 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
          <div className="px-4 py-2 text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">System</div>
          <div className="px-4 py-2 text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">Build</div>
          <div className="px-4 py-2 text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">Duration (Hrs)</div>
        </div>
        <div className="grid grid-cols-3 p-3 gap-2 border-b border-zinc-100 dark:border-zinc-800">
          <Dropdown label="" value={size} placeholder="Select system…" required>
            <div className="px-3 pt-2 pb-1 text-[9px] font-bold text-zinc-400 uppercase tracking-widest">Single Phase</div>
            {SIZES_1PH.map(s=>(<DItem key={s} onClick={()=>setSize(s)} active={size===s}>{s}</DItem>))}
            <div className="px-3 pt-2 pb-1 text-[9px] font-bold text-zinc-400 uppercase tracking-widest border-t border-zinc-100 dark:border-zinc-700 mt-1">Three Phase</div>
            {SIZES_3PH.map(s=>(<DItem key={s} onClick={()=>setSize(s)} active={size===s}>{s}</DItem>))}
          </Dropdown>
          <div className={ycls + ' flex items-center justify-between'}>
            <span>{cfg?.build || <span className="text-zinc-400">—</span>}</span>
            {cfg?.build && <CopyBtn val={cfg.build} id="build"/>}
          </div>
          <div className={ycls + ' flex items-center justify-between'}>
            <span>{cfg?.duration || <span className="text-zinc-400">—</span>}</span>
            {cfg?.duration && <CopyBtn val={cfg.duration} id="duration"/>}
          </div>
        </div>

        {/* Row 2: Project info */}
        <div className="grid grid-cols-3 bg-zinc-100 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
          <div className="px-4 py-2 text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">Project Title <span className="text-red-400">*</span></div>
          <div className="px-4 py-2 text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">Quote Reference <span className="text-red-400">*</span></div>
          <div className="px-4 py-2 text-xs font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">Sales Engineer <span className="text-red-400">*</span></div>
        </div>
        <div className="grid grid-cols-3 p-3 gap-2 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-1">
            <input value={pn} onChange={e=>setPN(e.target.value)} placeholder="e.g. Heathrow T5"
              className="flex-1 min-w-0 px-3 py-1.5 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-yellow-50 dark:bg-yellow-900/20 dark:text-zinc-100 focus:outline-none focus:border-blue-400 transition-colors font-semibold"/>
            {pn && <CopyBtn val={pn} id="pn"/>}
          </div>
          <div className="flex items-center gap-1">
            <input value={qr} onChange={e=>setQR(e.target.value)} placeholder="e.g. QB28154"
              className="flex-1 min-w-0 px-3 py-1.5 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-yellow-50 dark:bg-yellow-900/20 dark:text-zinc-100 focus:outline-none focus:border-blue-400 transition-colors font-semibold"/>
            {qr && <CopyBtn val={qr} id="qr"/>}
          </div>
          <Dropdown label="" value={sm?.name||''} placeholder="Select engineer…" required>
            {SALESMEN.map((s,i)=>(
              <DItem key={s.name} onClick={()=>setSmIdx(i)} active={smIdx===i}>
                <div className="text-xs font-medium">{s.name}</div>
                <div className="text-[10px] text-zinc-400">{s.phone}</div>
              </DItem>
            ))}
          </Dropdown>
        </div>

        <div className="px-4 py-2 text-[10px] text-amber-600 dark:text-amber-400">
          * Ensure Unit prices are added to Bidman and correctly quantified. Pricing is Sell Out at 1.0 multiplier.
        </div>
      </div>

      {/* ── BoM table ────────────────────────────────────────────────────────── */}
      {cfg && (
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-zinc-700 dark:bg-zinc-800 text-white">
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide w-44">Item</th>
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide">Catalogue #</th>
                  <th className="text-center px-3 py-3 text-xs font-bold uppercase tracking-wide w-12">Qty</th>
                  <th className="text-right px-3 py-3 text-xs font-bold uppercase tracking-wide">Unit Price</th>
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide">Description</th>
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide">Product ID</th>
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide hidden lg:table-cell">Cabinet Type</th>
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide hidden xl:table-cell">H×W×D (mm)</th>
                  <th className="text-left px-3 py-3 text-xs font-bold uppercase tracking-wide hidden xl:table-cell">Weight</th>
                </tr>
              </thead>
              <tbody>
                {cfg.rows.map((r,i)=>{
                  const active = r.qty > 0 && r.catNo !== 'N/A' && r.catNo !== '—' && r.catNo !== 'Included';
                  const stripe = i % 2 === 0 ? 'bg-white dark:bg-zinc-900' : 'bg-zinc-50 dark:bg-zinc-800/50';
                  return (
                    <tr key={i} className={`border-b border-zinc-200 dark:border-zinc-700 transition-colors ${stripe}${active?' hover:bg-yellow-50/60 dark:hover:bg-yellow-900/10':' opacity-40'}`}>
                      <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-400 font-semibold">{r.label}</td>
                      <td className={`px-3 py-2.5 font-mono whitespace-nowrap${active?' text-zinc-900 dark:text-zinc-100':' text-zinc-400'}`}>
                        <div className="flex items-center gap-1">
                          <span>{r.catNo}</span>
                          {active && <CopyBtn val={r.catNo} id={`cat-${i}`}/>}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span className={active ? ycls + ' font-bold' : 'text-zinc-400'}>{r.qty || '—'}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono whitespace-nowrap font-semibold text-zinc-700 dark:text-zinc-200">
                        {r.price > 0 ? f2(r.price) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-zinc-700 dark:text-zinc-300">{r.desc || '—'}</td>
                      <td className="px-3 py-2.5 text-zinc-500 dark:text-zinc-400 whitespace-nowrap">{r.productId || '—'}</td>
                      <td className="px-3 py-2.5 text-zinc-500 dark:text-zinc-400 hidden lg:table-cell whitespace-nowrap">{r.cabType || '—'}</td>
                      <td className="px-3 py-2.5 font-mono text-zinc-500 dark:text-zinc-400 text-[10px] hidden xl:table-cell whitespace-nowrap">{r.dims || '—'}</td>
                      <td className="px-3 py-2.5 text-zinc-500 dark:text-zinc-400 hidden xl:table-cell whitespace-nowrap">{r.weight || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-zinc-700 dark:bg-zinc-800 text-white">
                  <td colSpan={3} className="px-3 py-2.5 text-xs font-bold uppercase tracking-wide text-right">System Total Cost</td>
                  <td className="px-3 py-2.5 text-right font-bold font-mono whitespace-nowrap text-emerald-300">
                    <div className="flex items-center justify-end gap-1">
                      {f2(cfg.total)}
                      <CopyBtn val={cfg.total.toFixed(2)} id="total"/>
                    </div>
                  </td>
                  <td colSpan={5}/>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

    </div>
  );
}
