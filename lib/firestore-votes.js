import { GoogleAuth } from 'google-auth-library';

export function createFirestoreVotes({projectId,stallIds,database='(default)',fetcher=fetch,tokenProvider}) {
  if (!projectId || !/^[a-z0-9-]+$/.test(projectId)) throw new Error('Firestore project ID required');
  const valid=new Set(stallIds);
  const base=`https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(database)}/documents/apeatsVoters`;
  const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/datastore']});
  async function request(url,options={}) {
    const token=tokenProvider?await tokenProvider():(await (await auth.getClient()).getAccessToken()).token;
    const r=await fetcher(url,{...options,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(10000)});
    if (!r.ok) throw new Error(`Vote storage unavailable (${r.status})`);
    return r.json();
  }
  function validate(id,stall) {
    if (!/^[a-z0-9-]{8,64}$/.test(id)) throw new Error('Bad voter id');
    if (!valid.has(stall)) throw new Error('Unknown cuisine');
  }
  async function patch(id,fields,mask) {
    await request(`${base}/${id}?updateMask.fieldPaths=${encodeURIComponent(mask)}`,{method:'PATCH',body:JSON.stringify({fields})});
  }
  return {
    backend:'firestore',
    async setFavorite(id,stall) {validate(id,stall);await patch(id,{favorite:{stringValue:stall}},'favorite');},
    async rate(id,stall,stars) {
      validate(id,stall);
      if (typeof stars!=='number'||!Number.isInteger(stars)||stars<1||stars>5) throw new Error('Stars must be 1-5');
      await patch(id,{ratings:{mapValue:{fields:{[stall]:{integerValue:String(stars)}}}}},`ratings.\`${stall}\``);
    },
    async summary(id) {
      const favorites=Object.fromEntries(stallIds.map(s=>[s,0]));
      const totals=Object.fromEntries(stallIds.map(s=>[s,{total:0,count:0}]));
      let mine={favorite:null,ratings:{}},favoriteVotes=0,page='';
      do {
        const result=await request(`${base}?pageSize=1000${page?'&pageToken='+encodeURIComponent(page):''}`);
        for (const d of result.documents??[]) {
          const favorite=d.fields?.favorite?.stringValue;
          const ratings=Object.fromEntries(Object.entries(d.fields?.ratings?.mapValue?.fields??{}).map(([k,v])=>[k,Number(v.integerValue)]));
          if(valid.has(favorite)){favorites[favorite]++;favoriteVotes++;}
          for(const [s,n] of Object.entries(ratings))if(valid.has(s)&&n>=1&&n<=5){totals[s].total+=n;totals[s].count++;}
          if(d.name.split('/').at(-1)===id)mine={favorite:favorite??null,ratings};
        }
        page=result.nextPageToken??'';
      } while(page);
      return {favorites,favoriteVotes,mine,ratings:Object.fromEntries(Object.entries(totals).map(([s,v])=>[s,{avg:v.count?Math.round(v.total/v.count*10)/10:null,count:v.count}]))};
    },
  };
}
