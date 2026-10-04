export default {
	fetch(request: Request): Response {
		const destination = new URL(request.url);
		destination.protocol = "https:";
		destination.hostname = "blog.app.nagutabby.uk";
		destination.port = "";

		return Response.redirect(destination.toString(), 301);
	},
};
