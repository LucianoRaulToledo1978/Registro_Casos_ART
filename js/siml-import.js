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
    const dnis = new Set(mails.map(r=>dni(r.dni)).filter(Boolean));
    if(dnis.size>1 || (old && dnis.size && dni(old.DNI) && !dnis.has(dni(old.DNI)))) {
      reject('DNI contradictorios entre correos o con el registro existente.');continue;
    }
    const known = new Map((old?.SIML_Movimientos || []).map(r=>[text(r.id_correo),r]));
    for (const mail of mails) known.set(text(mail.id_correo),mail);
    const sorted = [...known.values()].sort((a,b)=>text(a.fecha_correo).localeCompare(text(b.fecha_correo)) || (a._row||0)-(b._row||0));
    const origins = sorted.filter(r=>r.tipo==='DENUNCIA'||r.tipo==='REINGRESO');
    const latest = field => [...sorted].reverse().map(r=>text(r[field])).find(Boolean)||'';
    const originDates = new Set(origins.map(r=>ymd(r.tipo==='REINGRESO'?r.fecha_movimiento:r.fecha_accidente)));
    if(originDates.size>1 || originDates.has('')) {reject('Fechas de inicio faltantes o contradictorias.');continue;}
    const start = old ? ymd(old.Desde) : ([...originDates][0]||'');
    if(!start) {reject('Falta caso previo o denuncia con fecha de inicio.');continue;}
    if(old && originDates.size && !originDates.has(start)) {reject('La fecha Desde manual difiere del correo.');continue;}
    const lastType = text(sorted[sorted.length-1]?.tipo);
    const isRejected = lastType === 'RECHAZO';
    const closed = lastType === 'ALTA' || isRejected;
    const altas = sorted.filter(r=>r.tipo==='ALTA');
    let end = old ? ymd(old.Hasta) : '';
    if(lastType === 'ALTA') {
      const lastMailDate = text(altas[altas.length-1].fecha_correo);
      const ends = new Set(altas.filter(r=>text(r.fecha_correo)===lastMailDate).map(r=>ymd(r.fecha_desde)));
      if(ends.size!==1 || ends.has('')) {reject('Fecha de alta faltante o varias fechas para la última notificación.');continue;}
      end = [...ends][0];
      if(origins.some(r=>r.fecha_correo>lastMailDate)) {reject('Hay una reapertura posterior al alta: revisar secuencia.');continue;}
    }
    if (!closed && lastType === 'REINGRESO') end = '';
    if(end && end<start) {reject('El alta es anterior al inicio de la baja.');continue;}
    if(start>today || (end && end>today)) {reject('Fecha futura: revisar antes de importar.');continue;}
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
    if(lastType === 'ALTA') patch.Hasta = end;
    const desiredState = closed ? 'A' : 'NC';
    patch.TipoAccidente = desiredState;
    patch.Rechazado = isRejected ? 'SI' : 'NO';
    if (lastType === 'REINGRESO') patch.Hasta = ''; 
    const ids = [...new Set(mails.map(r=>text(r.id_correo)))];
    const processed = new Set(old?.SIML_IdCorreos || []);
    // Permite completar observaciones de correos importados con versiones anteriores.
    const accident = latest('tipo_accidente');
    const reporter = latest('denuncia_ingresada_por');
    const observation = accident || text(old?.Observacion);
    const stateChanged = patch.Rechazado !== text(old?.Rechazado) || desiredState !== text(old?.TipoAccidente) ||
      (lastType === 'ALTA' && end !== ymd(old?.Hasta)) ||
      (isRejected && old?.SIML_RechazoSinFecha !== true);
    const enriched = stateChanged || observation !== text(old?.Observacion) ||
      (reporter && (!text(old?.DenunciaIngresadaPor) || reporter !== text(old?.SIML_DenunciaIngresadaPor)));
    if(old && ids.every(id=>processed.has(id)) && !enriched) continue;
    patch.Observacion = observation;
    if (reporter) {
      patch.SIML_DenunciaIngresadaPor = reporter;
      if (!text(old?.DenunciaIngresadaPor)) patch.DenunciaIngresadaPor = reporter;
    }
    const calculation = isRejected && !end ? null : days(start,end||today);
    if (isRejected) patch.SIML_RechazoSinFecha = true;
    else patch.SIML_RechazoSinFecha = false;
    if (calculation) {
    patch['Dias_ Caidos'] = String(calculation.total);
    patch['Dias_ Caidos Mes (desde DESDE)'] = String(calculation.months[start.slice(0,7)]||0);
    patch.diasPorMes = calculation.months;
    } else if (!old) {
      patch['Dias_ Caidos'] = '';
      patch['Dias_ Caidos Mes (desde DESDE)'] = '';
      patch.diasPorMes = {};
    }
    patch.SIML_IdCorreos = [...new Set([...processed,...ids])];
    const history = new Map((old?.SIML_Movimientos || []).map(r=>[r.id_correo,r]));
    for(const mail of mails) {
      const { _row, ...data } = mail;
      history.set(text(mail.id_correo), data);
    }
    patch.SIML_Movimientos = [...history.values()];
    patch.SIML_SiniestroBase = number.slice(0,-3);
    patch.SIML_UltimoTipo = lastType;
    patch.SIML_TipoAccidente = latest('tipo_accidente');
    const id = old?.id || 'siml_'+number.replace(/\//g,'_');
    const expected = old ? Object.fromEntries(Object.entries(old).filter(([k])=>k!=='id')) : null;
    actions.push({id,expected,patch,siniestro:number,status:old?'ACTUALIZAR':'CREAR',
      rows:mails.length,Desde:start,Hasta:end,Nombre:fields.Nombre||old?.Nombre||'',
      reason:[dotacion.has(workerDni)?'':'Sin dotación: revisar área, provincia y legajo.', isRejected?'Rechazo: A/NC = A. Falta fecha efectiva; revisar Hasta y días manualmente.':''].filter(Boolean).join(' ')});
  }
  return {actions,pending,inputRows:rows.length};
}
