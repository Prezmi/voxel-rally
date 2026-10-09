class StubEl{constructor(t){this.tag=t;this.children=[];this.className='';this.textContent='';this.style={};this.parentNode=null}appendChild(c){c.parentNode=this;this.children.push(c);return c}removeChild(c){const i=this.children.indexOf(c);if(i>=0)this.children.splice(i,1);return c}}
class StubDoc{constructor(){this.body=new StubEl('body')}createElement(t){return new StubEl(t)}getElementById(){return null}}
const { settings } = await import('../src/core/settings.js');
settings.hudMode='MINIMAL';
const { RallyHud } = await import('../src/game/hud-rally.js');
const doc=new StubDoc(); const h=new RallyHud(doc);
console.log('root class:', h._root.className, 'mode:', h.mode);
const car={wheels:[0,1,2,3].map(()=>({alpha:0,kappa:0,slipEnergy:0,N:3000})),body:{groundSpeed:20},params:{engine:{redline:7000}},powertrain:{rpm:5000,gear:2},damage:{susp:[1,1,1,1],enginePowerScale:1}};
const stage={arc:500,furthest:500,state:'RUNNING',countdown:0,gates:[{arc:0,number:0},{arc:800,number:1},{arc:1600,number:2}],timing:{total:10,liveSplit:-3,limit:60,limitRemaining:50,penaltyTotal:0,sectors:[{index:1,from:0,to:800}],activeSector:{index:1,from:0,to:800},refUpTo:()=>0}};
const notes=[{apexArc:600,priority:1,text:'5R',severity:5,dir:'R'},{apexArc:700,priority:1,text:'4L',severity:4,dir:'L'}];
for(let i=0;i<40;i++) h.update(1/60,{car,stage,notes,voice:{currentText:''},stageName:'X'});
const filled=h.signChips.filter(c=>c.el.textContent!==''||c.txt.textContent!=='').length;
console.log('sign chips used in MINIMAL:', filled, 'classes:', h.signChips.map(c=>c.el.className).join(' | '));
console.log('cycle:', h.cycleMode(), h._root.className, '->', h.cycleMode(), h._root.className, '->', h.cycleMode(), h._root.className);
