const protectedRoute=pathname=>pathname==='/admin'
  ||pathname.startsWith('/admin/')
  ||pathname==='/my-tickets'
  ||pathname.startsWith('/my-tickets/')
  ||pathname.startsWith('/order/')
  ||pathname.startsWith('/checkout/');

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(!protectedRoute(url.pathname))return env.ASSETS.fetch(request);
    const notFound=await env.ASSETS.fetch(new Request(new URL('/404.html',url),request));
    return new Response(notFound.body,{status:404,headers:notFound.headers});
  }
};
