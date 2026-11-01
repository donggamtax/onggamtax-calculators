/* 서식 바로 작성 엔진
   - 서식 페이지는 window.DG_FORM 하나만 정의하면 됩니다.
     { id, title, pages:[{src:'p1.png', w:1191, h:1684}], fields:[ ... ] }
   - 칸(field): { id, p:쪽(1부터, 기본 1), x, y, w, h (쪽 크기 대비 %),
                 label, type:'text'|'area'|'check'|'money'|'num', ph, align:'c'|'r',
                 fs:글자 크기(쪽 너비의 %, 기본 1.9), sum:[더할 칸 id...], g:'칸 목록 묶음 제목' }
   - 입력 내용은 이 브라우저(localStorage)에만 저장되고 어디로도 보내지 않습니다. */
(function(){
  'use strict';
  var F=window.DG_FORM; if(!F) return;
  var KEY='dgform:'+F.id, vals={}, els={}, sideEls={};
  var $=function(s,r){return (r||document).querySelector(s)};
  var pagesBox=$('#pages'), sideList=$('#sideList'), savedEl=$('#saved');
  var EDIT=/[?&]edit=1/.test(location.search);

  function load(){try{var o=JSON.parse(localStorage.getItem(KEY)||'null');if(o&&o.v)vals=o.v}catch(e){}}
  var saveT;
  function save(){
    clearTimeout(saveT);
    saveT=setTimeout(function(){
      var has=Object.keys(vals).some(function(k){return vals[k]!==''&&vals[k]!==false&&vals[k]!=null});
      try{ if(has) localStorage.setItem(KEY,JSON.stringify({v:vals,t:Date.now()})); else localStorage.removeItem(KEY); }catch(e){}
      if(savedEl){savedEl.textContent=has?'이 기기에 자동 저장됨':'';savedEl.classList.toggle('on',has)}
    },250);
  }

  var digits=function(s){return String(s==null?'':s).replace(/[^\d-]/g,'')};
  var comma=function(s){var d=digits(s);if(d===''||d==='-')return d;var n=parseInt(d,10);return isNaN(n)?'':n.toLocaleString('ko-KR')};
  var num=function(s){var n=parseInt(digits(s),10);return isNaN(n)?0:n};

  function fieldById(id){for(var i=0;i<F.fields.length;i++)if(F.fields[i].id===id)return F.fields[i]}

  function setVal(id,v,from){
    vals[id]=v;
    var f=fieldById(id);
    [els[id],sideEls[id]].forEach(function(el){
      if(!el||el===from)return;
      if(f.type==='check'){ if(el.type==='checkbox') el.checked=!!v; else el.setAttribute('aria-checked',v?'true':'false'); }
      else el.value=v==null?'':v;
    });
    if(els[id]&&f.type!=='check') els[id].classList.toggle('empty',!v);
  }

  function recalc(){
    F.fields.forEach(function(f){
      if(!f.sum)return;
      var t=0,any=false;
      f.sum.forEach(function(id){var v=vals[id];if(v!==''&&v!=null){any=true;t+=num(v)}});
      setVal(f.id,any?t.toLocaleString('ko-KR'):'');
    });
  }

  function onInput(f,el){
    var v=el.value;
    if(f.type==='money'){var pos=el.value.length-el.selectionStart;v=comma(v);el.value=v;try{var p=Math.max(0,v.length-pos);el.setSelectionRange(p,p)}catch(e){}}
    else if(f.type==='num'){v=v.replace(/[^\d.\-]/g,'');el.value=v}
    setVal(f.id,v,el); recalc(); save();
  }

  function build(){
    pagesBox.innerHTML=''; els={};
    var pageEls=F.pages.map(function(pg,i){
      var d=document.createElement('div');d.className='page';d.style.aspectRatio=pg.w+'/'+pg.h;d.dataset.p=i+1;
      var im=document.createElement('img');im.src=pg.src;im.alt=F.title+' '+(i+1)+'쪽 원문';im.width=pg.w;im.height=pg.h;
      d.appendChild(im);
      if(F.pages.length>1){var n=document.createElement('span');n.className='pno';n.textContent=(i+1)+' / '+F.pages.length+'쪽';d.appendChild(n)}
      pagesBox.appendChild(d);return d;
    });
    F.fields.forEach(function(f){
      var pg=pageEls[(f.p||1)-1]; if(!pg) return;
      var el;
      if(f.type==='check'){
        el=document.createElement('button');el.type='button';el.className='ck';el.setAttribute('role','checkbox');
        el.setAttribute('aria-checked',vals[f.id]?'true':'false');
        el.addEventListener('click',function(){setVal(f.id,!vals[f.id]);save()});
      }else{
        el=document.createElement(f.type==='area'?'textarea':'input');
        if(el.tagName==='INPUT'){el.type='text';el.autocomplete='off'}
        el.className='fld'+(f.align==='c'?' c':f.align==='r'||f.type==='money'?' r':'')+(f.sum?' calc':'');
        if(f.type==='money'||f.type==='num')el.inputMode='numeric';
        if(f.ph)el.placeholder=f.ph;
        if(f.sum){el.readOnly=true;el.title='자동 합계'}
        el.value=vals[f.id]||'';
        el.addEventListener('input',function(){onInput(f,el)});
        if(!el.value)el.classList.add('empty');
      }
      el.setAttribute('aria-label',f.label||f.id);
      if(f.label&&!el.title)el.title=f.label;
      el.style.left=f.x+'%';el.style.top=f.y+'%';el.style.width=f.w+'%';el.style.height=f.h+'%';
      if(f.fs)el.style.setProperty('--fs',f.fs);
      el.dataset.id=f.id; pg.appendChild(el); els[f.id]=el;
    });
  }

  function buildSide(){
    if(!sideList)return; sideList.innerHTML=''; sideEls={};
    F.fields.forEach(function(f,i){
      if(f.g){var g=document.createElement('div');g.className='grp';g.textContent=f.g;sideList.appendChild(g)}
      var id='s_'+f.id, el;
      if(f.type==='check'){
        var lb=document.createElement('label');lb.className='chk';
        el=document.createElement('input');el.type='checkbox';el.id=id;el.checked=!!vals[f.id];
        el.addEventListener('change',function(){setVal(f.id,el.checked,el);save()});
        lb.appendChild(el);lb.appendChild(document.createTextNode(f.label||f.id));sideList.appendChild(lb);
      }else{
        var l=document.createElement('label');l.htmlFor=id;l.textContent=f.label||f.id;sideList.appendChild(l);
        el=document.createElement(f.type==='area'?'textarea':'input');el.className='in';el.id=id;
        if(el.tagName==='INPUT'){el.type='text';el.autocomplete='off'}
        if(f.type==='money'||f.type==='num')el.inputMode='numeric';
        if(f.ph)el.placeholder=f.ph;
        if(f.sum){el.readOnly=true;el.placeholder='자동 합계'}
        el.value=vals[f.id]||'';
        el.addEventListener('input',function(){onInput(f,el)});
        sideList.appendChild(el);
      }
      el.addEventListener('focus',function(){var t=els[f.id];if(!t)return;t.classList.remove('hit');void t.offsetWidth;t.classList.add('hit');
        if(window.matchMedia('(min-width:1061px)').matches)t.scrollIntoView({block:'center',behavior:'smooth'})});
      sideEls[f.id]=el;
    });
  }

  /* 버튼 */
  var on=function(sel,fn){var b=$(sel);if(b)b.addEventListener('click',fn)};
  on('#btnPrint',function(){window.print()});
  on('#btnClear',function(){
    if(!confirm('작성한 내용을 모두 지울까요? 이 기기에 저장된 내용도 함께 지워집니다.'))return;
    vals={};try{localStorage.removeItem(KEY)}catch(e){}
    build();buildSide();save();
  });
  on('#btnList',function(){document.body.classList.add('list-open')});
  on('#btnListClose',function(){document.body.classList.remove('list-open')});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')document.body.classList.remove('list-open')});
  document.addEventListener('click',function(e){
    if(document.body.classList.contains('list-open')&&!e.target.closest('.side')&&!e.target.closest('#btnList'))document.body.classList.remove('list-open');
  });

  load(); build(); buildSide(); recalc(); save();
  if(EDIT) editMode();

  /* ───── 칸 위치 잡기 모드 (주소 뒤에 ?edit=1) ─────
     쪽 위를 끌어서 칸을 만들고, 칸을 끌어서 옮깁니다.
     선택한 칸: 화살표 이동(Shift=크게), Alt+화살표 크기, Delete 삭제, 두 번 클릭 이름·종류 바꾸기 */
  function editMode(){
    var sel=null,boxes={};
    var panel=document.createElement('div');panel.className='epanel';
    panel.innerHTML='<b>칸 위치 잡기</b> · 끌어서 새 칸, 선택 후 화살표·Alt+화살표·Delete, 두 번 클릭으로 이름 바꾸기'+
      '<textarea id="ejson" spellcheck="false"></textarea><div class="row">'+
      '<button class="b" id="eApply" type="button">글 내용 적용</button><button class="b" id="eCopy" type="button">복사</button>'+
      '<button class="b" id="eTry" type="button">써 보기 ↔ 편집</button></div>';
    document.body.appendChild(panel);
    var ta=$('#ejson'),editing=true;
    var r2=function(n){return Math.round(n*100)/100};
    function dump(){ta.value='[\n'+F.fields.map(function(f){return ' '+JSON.stringify(f)}).join(',\n')+'\n]'}
    function draw(){
      Object.keys(boxes).forEach(function(k){boxes[k].remove()});boxes={};
      F.fields.forEach(function(f){
        var pg=pagesBox.children[(f.p||1)-1];if(!pg)return;
        var b=document.createElement('div');b.className='ebox'+(sel===f?' sel':'');
        b.style.cssText='left:'+f.x+'%;top:'+f.y+'%;width:'+f.w+'%;height:'+f.h+'%';
        b.innerHTML='<span>'+f.id+'</span>';
        b.addEventListener('mousedown',function(e){e.stopPropagation();sel=f;draw();drag(e,pg,f)});
        b.addEventListener('dblclick',function(){rename(f)});
        pg.appendChild(b);boxes[f.id]=b;
      });
      dump();
    }
    function rect(pg){return pg.getBoundingClientRect()}
    function drag(e,pg,f){
      var r=rect(pg),sx=e.clientX,sy=e.clientY,ox=f.x,oy=f.y;
      function mv(ev){f.x=r2(ox+(ev.clientX-sx)/r.width*100);f.y=r2(oy+(ev.clientY-sy)/r.height*100);boxes[f.id].style.left=f.x+'%';boxes[f.id].style.top=f.y+'%'}
      function up(){document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);rebuild()}
      document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    }
    function rename(f){
      var id=prompt('칸 id (영문)',f.id);if(id==null)return;
      var lb=prompt('칸 이름 (칸 목록에 보일 이름)',f.label||'');if(lb==null)return;
      var ty=prompt('종류: text / area / check / money / num',f.type||'text');if(ty==null)return;
      f.id=id;f.label=lb;if(ty==='text')delete f.type;else f.type=ty;rebuild();
    }
    function rebuild(){build();buildSide();recalc();setEditing(editing);draw()}
    function setEditing(v){editing=v;Array.prototype.forEach.call(pagesBox.children,function(pg){pg.classList.toggle('editing',v)});
      Object.keys(boxes).forEach(function(k){boxes[k].style.display=v?'':'none'})}
    pagesBox.addEventListener('mousedown',function(e){
      if(!editing)return;var pg=e.target.closest('.page');if(!pg||e.button!==0)return;e.preventDefault();
      var r=rect(pg),x0=(e.clientX-r.left)/r.width*100,y0=(e.clientY-r.top)/r.height*100;
      var g=document.createElement('div');g.className='ebox sel';pg.appendChild(g);
      function mv(ev){var x1=(ev.clientX-r.left)/r.width*100,y1=(ev.clientY-r.top)/r.height*100;
        g.style.cssText='left:'+Math.min(x0,x1)+'%;top:'+Math.min(y0,y1)+'%;width:'+Math.abs(x1-x0)+'%;height:'+Math.abs(y1-y0)+'%'}
      function up(ev){document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);
        var x1=(ev.clientX-r.left)/r.width*100,y1=(ev.clientY-r.top)/r.height*100;g.remove();
        if(Math.abs(x1-x0)<.6||Math.abs(y1-y0)<.4)return;
        var n=1;while(fieldById('f'+n))n++;
        var f={id:'f'+n,p:+pg.dataset.p,x:r2(Math.min(x0,x1)),y:r2(Math.min(y0,y1)),w:r2(Math.abs(x1-x0)),h:r2(Math.abs(y1-y0)),label:'칸 '+n};
        F.fields.push(f);sel=f;rebuild();}
      document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    });
    document.addEventListener('keydown',function(e){
      if(!sel||!editing||e.target===ta||/INPUT|TEXTAREA/.test(e.target.tagName))return;
      var s=e.shiftKey?1:.1,k=e.key,h=true;
      if(e.altKey){if(k==='ArrowRight')sel.w=r2(sel.w+s);else if(k==='ArrowLeft')sel.w=r2(sel.w-s);else if(k==='ArrowDown')sel.h=r2(sel.h+s);else if(k==='ArrowUp')sel.h=r2(sel.h-s);else h=false}
      else if(k==='ArrowRight')sel.x=r2(sel.x+s);else if(k==='ArrowLeft')sel.x=r2(sel.x-s);else if(k==='ArrowDown')sel.y=r2(sel.y+s);else if(k==='ArrowUp')sel.y=r2(sel.y-s);
      else if(k==='Delete'||k==='Backspace'){F.fields.splice(F.fields.indexOf(sel),1);sel=null}else h=false;
      if(h){e.preventDefault();rebuild()}
    });
    on('#eApply',function(){try{F.fields=JSON.parse(ta.value);sel=null;rebuild()}catch(err){alert('글 형식이 맞지 않습니다: '+err.message)}});
    on('#eCopy',function(){ta.select();try{navigator.clipboard.writeText(ta.value)}catch(e){document.execCommand('copy')}});
    on('#eTry',function(){setEditing(!editing)});
    setEditing(true);draw();
  }
})();
