// Monta a spec Deneb (Vega 5). GeoJSON do Brasil embutido (Deneb não permite URLs externas).
const fs=require('fs');
const geo=JSON.parse(fs.readFileSync(__dirname+'/geo/brasil_ufs.geojson'));const viz=JSON.parse(fs.readFileSync(__dirname+'/geo/paises_vizinhos.geojson'));
const spec={
 "$schema":"https://vega.github.io/schema/vega/v5.json",
 "autosize":"none","padding":0,
 "signals":[
  {"name":"curvatura","value":0.22},
  {"name":"bboxFeature","update":"data('bbox')[0].f"}
 ],
 "data":[
  {"name":"dataset"},
  {"name":"vizinhos","values":viz,"format":{"type":"json","property":"features"}},
  {"name":"brasil","values":geo,"format":{"type":"json","property":"features"}},
  {"name":"bbox","source":"dataset","transform":[
    {"type":"aggregate","fields":["LonOrigem","LonDestino","LatOrigem","LatDestino","LonOrigem","LonDestino","LatOrigem","LatDestino"],
     "ops":["min","min","min","min","max","max","max","max"],
     "as":["a","b","c","d","e","f2","g","h"]},
    {"type":"formula","as":"f","expr":"{type:'Feature',geometry:{type:'MultiPoint',coordinates:[[min(datum.a,datum.b)-1.2,min(datum.c,datum.d)-1.2],[max(datum.e,datum.f2)+4.5,max(datum.g,datum.h)+1.2]]}}"}
  ]},
  {"name":"fluxos","source":"dataset","transform":[
    {"type":"formula","as":"Status","expr":"(datum.Realizado_t||0)==0 && (datum.Orcado_t||0)>0 ? 'Sem realizado' : !(datum.Orcado_t>0) ? 'Sem orçamento' : datum.Realizado_t>datum.Orcado_t ? 'Acima do orçado' : 'Dentro do orçado'"},
    {"type":"geopoint","projection":"proj","fields":["LonOrigem","LatOrigem"],"as":["x1","y1"]},
    {"type":"geopoint","projection":"proj","fields":["LonDestino","LatDestino"],"as":["x2","y2"]},
    {"type":"formula","as":"cx","expr":"(datum.x1+datum.x2)/2 + (datum.y2-datum.y1)*curvatura"},
    {"type":"formula","as":"cy","expr":"(datum.y1+datum.y2)/2 - (datum.x2-datum.x1)*curvatura"},
    {"type":"formula","as":"caminho","expr":"'M'+datum.x1+','+datum.y1+' Q'+datum.cx+','+datum.cy+' '+datum.x2+','+datum.y2"},
    {"type":"collect","sort":{"field":"Realizado_t","order":"descending"}}
  ]},
  {"name":"destinos","source":"fluxos","transform":[
    {"type":"aggregate","groupby":["Destino","x2","y2"],"fields":["Realizado_t"],"ops":["sum"],"as":["t"]},
    {"type":"formula","as":"rotulo","expr":"datum.t>0 ? replace(format(datum.t,',.0f'),/,/g,'.')+' t' : 'sem realizado'"}
  ]},
  {"name":"origens","source":"fluxos","transform":[
    {"type":"aggregate","groupby":["Origem","x1","y1"]}
  ]}
 ],
 "projections":[{"name":"proj","type":"mercator","fit":{"signal":"bboxFeature"},"size":[{"signal":"width"},{"signal":"height"}]}],
 "scales":[
  {"name":"cor","type":"ordinal","domain":["Dentro do orçado","Acima do orçado","Sem orçamento","Sem realizado"],"range":["#2E9E5B","#E0533D","#E59A1C","#A8A8A8"]},
  {"name":"espessura","type":"sqrt","domain":{"data":"fluxos","field":"Realizado_t"},"zero":true,"range":[1,9]}
 ],
 "legends":[{"stroke":"cor","symbolType":"stroke","orient":"bottom-right","offset":12,"title":"Espessura = toneladas","titleOrient":"bottom","titleFontWeight":"normal","titleFontSize":11,"titleLimit":300,
   "padding":10,"cornerRadius":6,"labelFontSize":11,"symbolStrokeWidth":3,"symbolSize":220,
   "encode":{"legend":{"update":{"fill":{"value":"#FFFFFF"},"stroke":{"value":"#DDDDDD"}}},"symbols":{"update":{"strokeDash":{"signal":"datum.value=='Sem realizado' ? [4,3] : [1,0]"}}}}}],
 "marks":[
  {"type":"rect","encode":{"enter":{"x":{"value":0},"y":{"value":0},"width":{"signal":"width"},"height":{"signal":"height"},"fill":{"value":"#AAD3DF"}}}},
  {"type":"shape","from":{"data":"vizinhos"},"encode":{"enter":{"fill":{"value":"#E4E1DA"},"stroke":{"value":"#C9B8D6"},"strokeWidth":{"value":1}}},"transform":[{"type":"geoshape","projection":"proj"}]},
  {"type":"shape","from":{"data":"brasil"},"encode":{"enter":{"fill":{"value":"#F2EFE9"},"stroke":{"value":"#B9A9C9"},"strokeWidth":{"value":0.8}}},"transform":[{"type":"geoshape","projection":"proj"}]},
  {"type":"path","name":"arcos","from":{"data":"fluxos"},"encode":{"update":{
     "path":{"field":"caminho"},"fill":{"value":null},"stroke":{"scale":"cor","field":"Status"},
     "strokeWidth":{"signal":"datum.Status=='Sem realizado' ? 3 : scale('espessura',datum.Realizado_t)"},
     "strokeDash":{"signal":"datum.Status=='Sem realizado' ? [6,4] : [1,0]"},
     "strokeCap":{"value":"round"},"strokeOpacity":{"value":0.85},
     "tooltip":{"signal":"{'Origem':datum.Origem,'Destino':datum.Destino,'Realizado (t)':datum.Realizado_t,'Orçado (t)':datum.Orcado_t,'Status':datum.Status}"}}}},
  {"type":"symbol","name":"pontosOrigem","from":{"data":"origens"},"encode":{"update":{"x":{"field":"x1"},"y":{"field":"y1"},"size":{"value":110},"fill":{"value":"#1F7A4A"},"stroke":{"value":"#FFFFFF"},"strokeWidth":{"value":2}}}},
  {"type":"symbol","name":"pontosDestino","from":{"data":"destinos"},"encode":{"update":{"x":{"field":"x2"},"y":{"field":"y2"},"size":{"value":70},"fill":{"value":"#FFFFFF"},"stroke":{"value":"#1F3B2D"},"strokeWidth":{"value":2}}}},
  {"type":"text","name":"rotProxy","from":{"data":"pontosDestino"},"encode":{"enter":{
     "text":{"signal":"substring(length(datum.datum.Destino)>length(datum.datum.rotulo)?datum.datum.Destino:datum.datum.rotulo,0,ceil(max(length(datum.datum.Destino),length(datum.datum.rotulo))*0.47))"},
     "fontSize":{"value":26},"fontWeight":{"value":"bold"},"fill":{"value":"transparent"}}},
   "transform":[{"type":"label","size":{"signal":"[width,height]"},"offset":[6,6,6,6,6,6,6,6],"anchor":["right","bottom-right","top-right","left","bottom-left","top-left","top","bottom"],"avoidMarks":["pontosOrigem","pontosDestino","rotOrigem"],"padding":0}]},
  {"type":"text","from":{"data":"rotProxy"},"encode":{"update":{"x":{"signal":"datum.opacity>0 ? datum.x : datum.datum.x+8"},
     "y":{"signal":"datum.opacity>0 ? (datum.baseline=='top' ? datum.y : datum.baseline=='bottom' ? datum.y-26 : datum.y-13) : datum.datum.y-13"},
     "align":{"signal":"datum.opacity>0 ? datum.align : 'left'"},"baseline":{"value":"top"},
     "text":{"signal":"[datum.datum.datum.Destino, datum.datum.datum.rotulo]"},"fontSize":{"value":11},"lineHeight":{"value":13},"fontWeight":{"value":"bold"},"fill":{"value":"#1A1A1A"}}}},
  {"type":"text","name":"rotOrigem","from":{"data":"origens"},"encode":{"update":{"x":{"field":"x1"},"y":{"field":"y1"},"dx":{"value":-4},"dy":{"value":-9},
     "text":{"field":"Origem"},"fontSize":{"value":13},"fontWeight":{"value":"bold"},"fill":{"value":"#1F5C3A"},"align":{"value":"left"}}}}
 ]
};
{const i=spec.marks.findIndex(m=>m.name=='rotProxy');spec.marks.push(...spec.marks.splice(i,2));}
fs.writeFileSync(__dirname+'/deneb_spec_fluxos.json',JSON.stringify(spec,null,1));
