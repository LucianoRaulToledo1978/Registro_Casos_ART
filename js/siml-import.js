// Planificación sin escribir en Firebase. Una acción por número completo de siniestro.
export const text = v => String(v ?? '').trim();
const sin = v => text(v).replace(/\s/g, '');
const dni = v => text(v).replace(/\D/g, '');
export function ymd(v) {
  const s = text(v).slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(s+'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s ? s : '';
}
export function days(start, end) {
  if (!ymd(start) || !ymd(end) || end < start) return null;
  const day = 86400000;
  const total = Math.round((Date.parse(end)-Date.parse(start))/day)+1;
  const months = {};
  let cursor = new Date(start+'T00:00:00Z');
  while (cursor.toISOString().slice(0,10) <= end) {
    const key = cursor.toISOString().slice(0,7);
    const last = new Date(Date.UTC(cursor.getUTCFullYear(),cursor.getUTCMonth()+1,0)).toISOString().slice(0,10);
    const a = cursor.toISOString().slice(0,10), b = last < end ? last : end;
    months[key] = Math.round((Date.parse(b)-Date.parse(a))/day)+1;
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(),cursor.getUTCMonth()+1,1));
  }
  return {total,months};
}
export function buildPlan(rows, existing, dotacion, today) {
  const groups = new Map(), pending = [];
  rows.forEach((r,index) => {
    const number = sin(r.siniestro);
    const reason = !text(r.id_correo) ? 'Falta id_correo' :
      !/^\d{8}\/\d{3}\/\d{2}$/.test(number) ? 'Número de siniestro inválido' :
      !['DENUNCIA','ALTA','REINGRESO','RECHAZO'].includes(text(r.tipo)) ? 'Tipo desconocido' :
      !ymd(r.fecha_correo) ? 'Fecha de correo inválida' : '';
    if(reason) {pending.push({siniestro:number,status:'PENDIENTE',reason,rows:1});return;}
    if(!groups.has(number)) groups.set(number,[]);
    groups.get(number).push({...r,siniestro:number,_row:index+2});
  });
  const actions = [];
  for(const [number, mails] of groups) {
    const reject = reason => pending.push({siniestro:number,status:'PENDIENTE',reason,rows:mails.length});
    const matches = existing.filter(r=>sin(r.Nro_Siniestro)===number);
    if(matches.length>1) {reject('Hay varios registros existentes para este número; resolver duplicados.');continue;}
    const old = matches[0] || null;
    if(mails.some(r=>r.tipo==='RECHAZO')) {reject('El Excel no contiene fecha efectiva de rechazo: requiere revisión manual.');continue;}
    const dnis = new Set(mails.map(r=>dni(r.dni)).filter(Boolean));
    if(dnis.size>1 || (old && dnis.size && dni(old.DNI) && !dnis.has(dni(old.DNI)))) {
      reject('DNI contradictorios entre correos o con el registro existente.');continue;
    }
    const sorted = mails.slice().sort((a,b)=>text(a.fecha_correo).localeCompare(text(b.fecha_correo)) || a._row-b._row);
    const origins = sorted.filter(r=>r.tipo==='DENUNCIA'||r.tipo==='REINGRESO');
    const latest = field => [...sorted].reverse().map(r=>text(r[field])).find(Boolean)||'';
    const originDates = new Set(origins.map(r=>ymd(r.tipo==='REINGRESO'?r.fecha_movimiento:r.fecha_accidente)));
    if(originDates.size>1 || originDates.has('')) {reject('Fechas de inicio faltantes o contradictorias.');continue;}
    const start = old ? ymd(old.Desde) : ([...originDates][0]||'');
    if(!start) {reject('Falta caso previo o denuncia con fecha de inicio.');continue;}
    if(old && originDates.size && !originDates.has(start)) {reject('La fecha Desde manual difiere del correo.');continue;}
    const altas = sorted.filter(r=>r.tipo==='ALTA');
    let end = old ? ymd(old.Hasta) : '';
    if(altas.length) {
      const lastMailDate = text(altas[altas.length-1].fecha_correo);
      const ends = new Set(altas.filter(r=>text(r.fecha_correo)===lastMailDate).map(r=>ymd(r.fecha_desde)));
      if(ends.size!==1 || ends.has('')) {reject('Fecha de alta faltante o varias fechas para la última notificación.');continue;}
      end = [...ends][0];
      if(origins.some(r=>r.fecha_correo>lastMailDate)) {reject('Hay una reapertura posterior al alta: revisar secuencia.');continue;}
    }
    if(end && end<start) {reject('El alta es anterior al inicio de la baja.');continue;}
    if(start>today || (end && end>today)) {reject('Fecha futura: revisar antes de importar.');continue;}
    if(old && /rechaz/i.test(text(old.Observacion))) {reject('Caso marcado como rechazado: revisar su reapertura manualmente.');continue;}
    const workerDni = [...dnis][0] || dni(old?.DNI);
    if(!workerDni || !latest('trabajador') && !text(old?.Nombre)) {reject('Faltan DNI o nombre.');continue;}
    const worker = dotacion.get(workerDni) || {};
    const patch = {};
    const fields = {DNI:workerDni, CUIL:latest('cuil'), Nombre:latest('trabajador'),
      Descripcion:latest('descripcion'), Prestador:latest('prestador'),
      Legajo:text(worker.Legajo), Ubicacion:text(worker['Unidad organizativa']), Funcion:text(worker['Posición']),
      Area:text(worker.Area), Provincia:text(worker.Provincia), Region:text(worker['Región (Estado federal, "land"']), Personal:text(worker.RRHH)};
    for(const [k,v] of Object.entries(fields)) if(v && !text(old?.[k])) patch[k]=v;
    if(!old) Object.assign(patch,{Nro_Siniestro:number,Fecha:latest('fecha_correo'),Desde:start,Hasta:end,
      TipoAccidente:end?'A':'NC',TipoDenuncia:'',CIE10:'',CIE10_Desc:'',Observacion:'', 'Envio Denuncia':''});
    if(altas.length) Object.assign(patch,{Hasta:end,TipoAccidente:'A'});
    const ids = [...new Set(mails.map(r=>text(r.id_correo)))];
    const processed = new Set(old?.SIML_IdCorreos || []);
    if(old && ids.every(id=>processed.has(id))) continue;
    const calculation = days(start,end||today);
    patch['Dias_ Caidos'] = String(calculation.total);
    patch['Dias_ Caidos Mes (desde DESDE)'] = String(calculation.months[start.slice(0,7)]||0);
    patch.diasPorMes = calculation.months;
    patch.SIML_IdCorreos = [...new Set([...processed,...ids])];
    const history = new Map((old?.SIML_Movimientos || []).map(r=>[r.id_correo,r]));
    for(const mail of mails) {
      const { _row, ...data } = mail;
      history.set(text(mail.id_correo), data);
    }
    patch.SIML_Movimientos = [...history.values()];
    patch.SIML_SiniestroBase = number.slice(0,-3);
    patch.SIML_UltimoTipo = altas.length?'ALTA':text(origins[origins.length-1]?.tipo);
    patch.SIML_TipoAccidente = latest('tipo_accidente');
    const id = old?.id || 'siml_'+number.replace(/\//g,'_');
    const expected = old ? Object.fromEntries(Object.entries(old).filter(([k])=>k!=='id')) : null;
    actions.push({id,expected,patch,siniestro:number,status:old?'ACTUALIZAR':'CREAR',
      rows:mails.length,Desde:start,Hasta:end,Nombre:fields.Nombre||old?.Nombre||'',
      reason:dotacion.has(workerDni)?'':'Sin dotación: revisar área, provincia y legajo.'});
  }
  return {actions,pending,inputRows:rows.length};
}
