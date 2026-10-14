using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace TalosDiagnostic
{
    internal static class AppInfo
    {
        public static readonly string Version = typeof(AppInfo).Assembly.GetName().Version.ToString(3);
    }

    // Sends the report to the website and builds the results URL.
    //
    // The app always generates its own session token and opens the results
    // page itself. It never accepts a token from outside (protocol URI,
    // web page): otherwise any site could launch the app with a token it
    // controls and read this PC's report through /api/diag/poll.
    internal static class ReportClient
    {
        public const string DefaultOrigin = "https://www.talos-int.com";

        public static string NewToken()
        {
            var bytes = new byte[16];
            using (var rng = new RNGCryptoServiceProvider()) rng.GetBytes(bytes);
            return string.Concat(bytes.Select(b => b.ToString("x2")));
        }

        public static string ResultsUrl(string origin, string token) => origin + "/?diag=" + token;

        public static async Task SendAsync(string origin, string token, Dictionary<string, object> data, CancellationToken ct)
        {
            var body = Json.Serialize(new Dictionary<string, object> { ["session"] = token, ["data"] = data });
            using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(45) })
            {
                http.DefaultRequestHeaders.UserAgent.ParseAdd("TalosDiagnostic/" + AppInfo.Version);
                using (var content = new StringContent(body, Encoding.UTF8, "application/json"))
                using (var response = await http.PostAsync(origin + "/api/diag/collect", content, ct).ConfigureAwait(false))
                {
                    if (!response.IsSuccessStatusCode)
                        throw new HttpRequestException("Réponse du serveur : HTTP " + (int)response.StatusCode);
                }
            }
        }
    }
}
