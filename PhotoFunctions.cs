using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using SimplePhotoApi;
using System.Net;
using System.Text.Json;

public class PhotoFunctions
{
    private readonly PhotoService _photoService;
    private readonly ILogger<PhotoFunctions> _logger;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public PhotoFunctions(PhotoService photoService, ILogger<PhotoFunctions> logger)
    {
        _photoService = photoService;
        _logger = logger;
    }

    private static string GetUserId(HttpRequestData req)
    {
        if (req.Headers.TryGetValues("X-User-Id", out var values))
            return values.FirstOrDefault() ?? "default";
        return "default";
    }

    [Function("GetPhotos")]
    public async Task<HttpResponseData> GetPhotos(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "photos")] HttpRequestData req)
    {
        var userId = GetUserId(req);
        var status = req.Query["status"];
        var search = req.Query["search"];
        
        var photos = await _photoService.GetPhotosAsync(userId, status, search);
        return await JsonResponse(req, photos);
    }

    [Function("GetPhoto")]
    public async Task<HttpResponseData> GetPhoto(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "photos/{id}")] HttpRequestData req,
        string id)
    {
        var userId = GetUserId(req);
        var photo = await _photoService.GetPhotoAsync(id, userId);
        
        if (photo == null)
            return req.CreateResponse(HttpStatusCode.NotFound);
            
        return await JsonResponse(req, photo);
    }

    [Function("InitiateUpload")]
    public async Task<HttpResponseData> InitiateUpload(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "photos/upload")] HttpRequestData req)
    {
        try
        {
            var userId = GetUserId(req);
            _logger.LogInformation("InitiateUpload called for user {UserId}", userId);
            
            var body = await JsonSerializer.DeserializeAsync<UploadRequest>(req.Body, JsonOptions);
            
            if (body?.FileName == null)
            {
                _logger.LogWarning("Bad request: fileName is null");
                return req.CreateResponse(HttpStatusCode.BadRequest);
            }
            
            _logger.LogInformation("Creating photo record for {FileName}", body.FileName);
            var photo = await _photoService.CreatePhotoAsync(body.FileName, userId);
            
            _logger.LogInformation("Getting upload URL for photo {PhotoId}", photo.Id);
            var uploadUrl = await _photoService.GetUploadUrlAsync(photo);
            
            _logger.LogInformation("Upload URL generated successfully");
            return await JsonResponse(req, new { photoId = photo.Id, uploadUrl }, HttpStatusCode.Created);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in InitiateUpload: {Message}", ex.Message);
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error: {ex.Message}");
            return errorResponse;
        }
    }

    [Function("ProcessPhoto")]
    public async Task<HttpResponseData> ProcessPhoto(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "photos/{id}/process")] HttpRequestData req,
        string id)
    {
        try
        {
            var userId = GetUserId(req);
            _logger.LogInformation("Processing photo {PhotoId} for user {UserId}", id, userId);
            
            var photo = await _photoService.ProcessPhotoAsync(id, userId);
            
            if (photo == null)
                return req.CreateResponse(HttpStatusCode.NotFound);
                
            return await JsonResponse(req, photo);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing photo {PhotoId}: {Message}", id, ex.Message);
            var errorResponse = req.CreateResponse(HttpStatusCode.InternalServerError);
            await errorResponse.WriteStringAsync($"Error: {ex.Message}");
            return errorResponse;
        }
    }

    [Function("UpdateCategories")]
    public async Task<HttpResponseData> UpdateCategories(
        [HttpTrigger(AuthorizationLevel.Anonymous, "put", Route = "photos/{id}/categories")] HttpRequestData req,
        string id)
    {
        var userId = GetUserId(req);
        var body = await JsonSerializer.DeserializeAsync<UpdateCategoriesRequest>(req.Body, JsonOptions);
        
        if (body?.Categories == null)
            return req.CreateResponse(HttpStatusCode.BadRequest);

        var photo = await _photoService.UpdateCategoriesAsync(id, userId, body.Categories);
        
        if (photo == null)
            return req.CreateResponse(HttpStatusCode.NotFound);
            
        return await JsonResponse(req, photo);
    }

    [Function("DeletePhoto")]
    public async Task<HttpResponseData> DeletePhoto(
        [HttpTrigger(AuthorizationLevel.Anonymous, "delete", Route = "photos/{id}")] HttpRequestData req,
        string id)
    {
        var userId = GetUserId(req);
        await _photoService.DeletePhotoAsync(id, userId);
        return req.CreateResponse(HttpStatusCode.NoContent);
    }

    [Function("GetDashboard")]
    public async Task<HttpResponseData> GetDashboard(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "dashboard")] HttpRequestData req)
    {
        var userId = GetUserId(req);
        var stats = await _photoService.GetStatsAsync(userId);
        return await JsonResponse(req, stats);
    }

    [Function("GetReviewQueue")]
    public async Task<HttpResponseData> GetReviewQueue(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "review")] HttpRequestData req)
    {
        var userId = GetUserId(req);
        var photos = await _photoService.GetPhotosAsync(userId, "needs_review");
        return await JsonResponse(req, photos);
    }

    [Function("GetCategories")]
    public async Task<HttpResponseData> GetCategories(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "categories")] HttpRequestData req)
    {
        var categories = new[]
        {
            new { id = "kitchen", name = "Kitchen", type = "room" },
            new { id = "bathroom", name = "Bathroom", type = "room" },
            new { id = "bedroom", name = "Bedroom", type = "room" },
            new { id = "living-room", name = "Living Room", type = "room" },
            new { id = "exterior", name = "Exterior", type = "room" },
            new { id = "garage", name = "Garage", type = "room" },
            new { id = "before", name = "Before", type = "stage" },
            new { id = "during", name = "During", type = "stage" },
            new { id = "after", name = "After", type = "stage" }
        };
        return await JsonResponse(req, categories);
    }

    // Album endpoints
    [Function("GetAlbums")]
    public async Task<HttpResponseData> GetAlbums(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "albums")] HttpRequestData req)
    {
        var userId = GetUserId(req);
        var albums = await _photoService.GetAlbumsAsync(userId);
        return await JsonResponse(req, albums);
    }

    [Function("CreateAlbum")]
    public async Task<HttpResponseData> CreateAlbum(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "albums")] HttpRequestData req)
    {
        var userId = GetUserId(req);
        var body = await JsonSerializer.DeserializeAsync<CreateAlbumRequest>(req.Body, JsonOptions);
        
        if (body?.Name == null)
            return req.CreateResponse(HttpStatusCode.BadRequest);

        var album = await _photoService.CreateAlbumAsync(body.Name, body.Description, userId);
        return await JsonResponse(req, album, HttpStatusCode.Created);
    }

    [Function("AddPhotosToAlbum")]
    public async Task<HttpResponseData> AddPhotosToAlbum(
        [HttpTrigger(AuthorizationLevel.Anonymous, "post", Route = "albums/{id}/photos")] HttpRequestData req,
        string id)
    {
        var userId = GetUserId(req);
        var body = await JsonSerializer.DeserializeAsync<AddPhotosRequest>(req.Body, JsonOptions);
        
        if (body?.PhotoIds == null)
            return req.CreateResponse(HttpStatusCode.BadRequest);

        var album = await _photoService.AddPhotosToAlbumAsync(id, userId, body.PhotoIds);
        
        if (album == null)
            return req.CreateResponse(HttpStatusCode.NotFound);
            
        return await JsonResponse(req, album);
    }

    [Function("Health")]
    public HttpResponseData Health(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "health")] HttpRequestData req)
    {
        var response = req.CreateResponse(HttpStatusCode.OK);
        response.WriteString("OK");
        return response;
    }

    private async Task<HttpResponseData> JsonResponse<T>(HttpRequestData req, T data, HttpStatusCode status = HttpStatusCode.OK)
    {
        var response = req.CreateResponse(status);
        response.Headers.Add("Content-Type", "application/json");
        await response.WriteStringAsync(JsonSerializer.Serialize(data, JsonOptions));
        return response;
    }
}

// Request DTOs
public record UploadRequest(string FileName);
public record UpdateCategoriesRequest(List<PhotoCategory> Categories);
public record CreateAlbumRequest(string Name, string? Description);
public record AddPhotosRequest(List<string> PhotoIds);
