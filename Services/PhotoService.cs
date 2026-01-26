using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Logging;
using Azure;
using Azure.AI.Vision.ImageAnalysis;
using Azure.Storage.Blobs;
using Azure.Storage.Sas;
using MetadataExtractor;
using MetadataExtractor.Formats.Exif;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Processing;
using System.Text.Json;

namespace SimplePhotoApi;

public class PhotoService
{
    private readonly CosmosClient _cosmosClient;
    private readonly Container _photosContainer;
    private readonly Container _albumsContainer;
    private readonly BlobServiceClient _blobClient;
    private readonly ImageAnalysisClient? _visionClient;
    private readonly ILogger _logger;

    public PhotoService(ILoggerFactory loggerFactory)
    {
        _logger = loggerFactory.CreateLogger<PhotoService>();
        
        var cosmosConn = Environment.GetEnvironmentVariable("CosmosDbConnectionString");
        var storageConn = Environment.GetEnvironmentVariable("AzureWebJobsStorage");
        var visionEndpoint = Environment.GetEnvironmentVariable("VisionEndpoint");
        var visionKey = Environment.GetEnvironmentVariable("VisionKey");

        _cosmosClient = new CosmosClient(cosmosConn);
        _photosContainer = _cosmosClient.GetContainer("renovation-photos", "photos");
        _albumsContainer = _cosmosClient.GetContainer("renovation-photos", "albums");
        _blobClient = new BlobServiceClient(storageConn);

        if (!string.IsNullOrEmpty(visionEndpoint) && !string.IsNullOrEmpty(visionKey))
        {
            _visionClient = new ImageAnalysisClient(new Uri(visionEndpoint), new AzureKeyCredential(visionKey));
            _logger.LogInformation("AI Vision client initialized");
        }
    }

    public async Task<Photo> CreatePhotoAsync(string fileName, string userId)
    {
        _logger.LogInformation("CreatePhotoAsync called with fileName={FileName}, userId={UserId}", fileName, userId);
        
        var photo = new Photo
        {
            Id = Guid.NewGuid().ToString(),
            UserId = userId,  // Partition key
            FileName = fileName,
            UploadedBy = userId,
            UploadedAt = DateTime.UtcNow,
            Status = "pending"
        };

        photo.BlobPath = $"{userId}/{photo.Id}/{fileName}";
        
        _logger.LogInformation("Creating photo with Id={Id}, UploadedBy={UploadedBy}", photo.Id, photo.UploadedBy);
        
        try 
        {
            await _photosContainer.CreateItemAsync(photo, new PartitionKey(photo.UploadedBy));
            _logger.LogInformation("Photo created successfully");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to create photo in Cosmos DB: {Message}", ex.Message);
            throw;
        }
        
        return photo;
    }

    public async Task<string> GetUploadUrlAsync(Photo photo)
    {
        var containerClient = _blobClient.GetBlobContainerClient("photos");
        await containerClient.CreateIfNotExistsAsync();
        
        var blobClient = containerClient.GetBlobClient(photo.BlobPath);
        var sasBuilder = new BlobSasBuilder
        {
            BlobContainerName = "photos",
            BlobName = photo.BlobPath,
            Resource = "b",
            ExpiresOn = DateTimeOffset.UtcNow.AddHours(1)
        };
        sasBuilder.SetPermissions(BlobSasPermissions.Write | BlobSasPermissions.Create);
        
        return blobClient.GenerateSasUri(sasBuilder).ToString();
    }

    public async Task<Photo?> ProcessPhotoAsync(string photoId, string userId)
    {
        try
        {
            var response = await _photosContainer.ReadItemAsync<Photo>(photoId, new PartitionKey(userId));
            var photo = response.Resource;
            
            _logger.LogInformation("Processing photo {PhotoId}", photoId);

            // Get blob
            var containerClient = _blobClient.GetBlobContainerClient("photos");
            var blobClient = containerClient.GetBlobClient(photo.BlobPath);
            
            using var stream = new MemoryStream();
            await blobClient.DownloadToAsync(stream);
            stream.Position = 0;

            // Extract EXIF first (before any conversion)
            photo.Exif = ExtractExif(stream);
            stream.Position = 0;

            // Convert HEIC to JPEG if needed
            var processStream = await ConvertHeicIfNeededAsync(stream, photo.FileName);

            // Generate thumbnail
            photo.ThumbnailBlobPath = await GenerateThumbnailAsync(processStream, photo, userId);
            processStream.Position = 0;

            // AI Vision analysis
            if (_visionClient != null)
            {
                photo.AiAnalysis = await AnalyzeWithVisionAsync(processStream);
                photo.Categories = ClassifyPhoto(photo.AiAnalysis);
                photo.Status = photo.Categories.Any(c => c.Confidence < 0.7) ? "needs_review" : "classified";
            }
            else
            {
                photo.Status = "uploaded";
            }

            // Generate view URLs
            photo.ThumbnailUrl = GenerateReadUrl("thumbnails", photo.ThumbnailBlobPath);
            photo.ImageUrl = GenerateReadUrl("photos", photo.BlobPath);

            // Save
            await _photosContainer.ReplaceItemAsync(photo, photo.Id, new PartitionKey(userId));
            _logger.LogInformation("Photo {PhotoId} processed successfully with {Count} categories", 
                photoId, photo.Categories?.Count ?? 0);
            
            return photo;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing photo {PhotoId}", photoId);
            throw;
        }
    }

    private ExifData? ExtractExif(Stream stream)
    {
        try
        {
            var directories = ImageMetadataReader.ReadMetadata(stream);
            var exif = new ExifData();

            var subIfd = directories.OfType<ExifSubIfdDirectory>().FirstOrDefault();
            if (subIfd != null)
            {
                if (subIfd.TryGetDateTime(ExifDirectoryBase.TagDateTimeOriginal, out var date))
                    exif.DateTaken = date;
                
                exif.CameraModel = subIfd.GetDescription(ExifDirectoryBase.TagModel);
            }

            var gps = directories.OfType<GpsDirectory>().FirstOrDefault();
            if (gps != null)
            {
                var lat = gps.GetRationalArray(GpsDirectory.TagLatitude);
                var latRef = gps.GetString(GpsDirectory.TagLatitudeRef);
                var lon = gps.GetRationalArray(GpsDirectory.TagLongitude);
                var lonRef = gps.GetString(GpsDirectory.TagLongitudeRef);
                
                if (lat != null && lon != null)
                {
                    exif.Latitude = ConvertToDecimalDegrees(lat) * (latRef == "S" ? -1 : 1);
                    exif.Longitude = ConvertToDecimalDegrees(lon) * (lonRef == "W" ? -1 : 1);
                }
            }

            return exif;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to extract EXIF");
            return null;
        }
    }

    private async Task<Stream> ConvertHeicIfNeededAsync(Stream inputStream, string fileName)
    {
        var ext = Path.GetExtension(fileName)?.ToLowerInvariant();
        if (ext == ".heic" || ext == ".heif")
        {
            try
            {
                _logger.LogInformation("Converting HEIC/HEIF file to JPEG: {FileName}", fileName);
                
                // ImageSharp can read HEIC files and convert them
                using var image = await SixLabors.ImageSharp.Image.LoadAsync(inputStream);
                var outputStream = new MemoryStream();
                await image.SaveAsJpegAsync(outputStream);
                outputStream.Position = 0;
                
                _logger.LogInformation("HEIC conversion successful for {FileName}", fileName);
                return outputStream;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "HEIC conversion failed for {FileName}, using original stream", fileName);
                inputStream.Position = 0;
                return inputStream;
            }
        }
        
        inputStream.Position = 0;
        return inputStream;
    }

    private async Task<string> GenerateThumbnailAsync(Stream stream, Photo photo, string userId)
    {
        using var image = await SixLabors.ImageSharp.Image.LoadAsync(stream);
        image.Mutate(x => x.Resize(new ResizeOptions
        {
            Size = new SixLabors.ImageSharp.Size(400, 400),
            Mode = ResizeMode.Max
        }));

        var thumbnailPath = $"{userId}/{photo.Id}/thumb.jpg";
        var containerClient = _blobClient.GetBlobContainerClient("thumbnails");
        await containerClient.CreateIfNotExistsAsync();
        
        using var thumbStream = new MemoryStream();
        await image.SaveAsJpegAsync(thumbStream);
        thumbStream.Position = 0;
        
        var blobClient = containerClient.GetBlobClient(thumbnailPath);
        await blobClient.UploadAsync(thumbStream, overwrite: true);
        
        return thumbnailPath;
    }

    private async Task<AiAnalysisResult?> AnalyzeWithVisionAsync(Stream stream)
    {
        if (_visionClient == null) return null;

        try
        {
            var data = BinaryData.FromStream(stream);
            var result = await _visionClient.AnalyzeAsync(
                data,
                VisualFeatures.Caption | VisualFeatures.Tags | VisualFeatures.Objects);

            var tags = new List<AiTag>();
            if (result.Value.Tags != null)
            {
                foreach (var tag in result.Value.Tags.Values)
                {
                    tags.Add(new AiTag { Name = tag.Name, Confidence = tag.Confidence });
                }
            }
            
            var objects = new List<string>();
            if (result.Value.Objects != null)
            {
                foreach (var obj in result.Value.Objects.Values)
                {
                    foreach (var tag in obj.Tags)
                    {
                        objects.Add(tag.Name);
                    }
                }
            }

            return new AiAnalysisResult
            {
                Caption = result.Value.Caption?.Text,
                CaptionConfidence = result.Value.Caption?.Confidence ?? 0,
                Tags = tags,
                Objects = objects
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Vision analysis failed");
            return null;
        }
    }

    private static double ConvertToDecimalDegrees(MetadataExtractor.Rational[] dms)
    {
        return dms[0].ToDouble() + dms[1].ToDouble() / 60 + dms[2].ToDouble() / 3600;
    }

    private List<PhotoCategory> ClassifyPhoto(AiAnalysisResult? analysis)
    {
        var categories = new List<PhotoCategory>();
        if (analysis == null) return categories;

        // Room classification based on tags and objects
        var roomKeywords = new Dictionary<string, string[]>
        {
            ["kitchen"] = new[] { "kitchen", "stove", "oven", "refrigerator", "sink", "cabinet", "counter", "cooking" },
            ["bathroom"] = new[] { "bathroom", "toilet", "shower", "bathtub", "sink", "tile", "mirror" },
            ["bedroom"] = new[] { "bedroom", "bed", "mattress", "pillow", "closet", "dresser" },
            ["living-room"] = new[] { "living", "sofa", "couch", "television", "tv", "fireplace", "carpet" },
            ["exterior"] = new[] { "outdoor", "garden", "yard", "patio", "deck", "roof", "siding", "window" },
            ["garage"] = new[] { "garage", "car", "tool", "workshop" }
        };

        var allTags = analysis.Tags.Select(t => t.Name.ToLower()).ToList();
        allTags.AddRange(analysis.Objects.Select(o => o.ToLower()));
        if (analysis.Caption != null) allTags.Add(analysis.Caption.ToLower());

        foreach (var (room, keywords) in roomKeywords)
        {
            var matches = keywords.Count(k => allTags.Any(t => t.Contains(k)));
            if (matches > 0)
            {
                var confidence = Math.Min(0.5 + (matches * 0.15), 0.95);
                categories.Add(new PhotoCategory { Name = room, Type = "room", Confidence = confidence });
            }
        }

        // Stage classification
        var stageKeywords = new Dictionary<string, string[]>
        {
            ["before"] = new[] { "old", "damaged", "worn", "dirty", "broken", "outdated" },
            ["during"] = new[] { "construction", "renovation", "work", "tool", "debris", "unfinished" },
            ["after"] = new[] { "new", "finished", "clean", "modern", "completed", "renovated" }
        };

        foreach (var (stage, keywords) in stageKeywords)
        {
            var matches = keywords.Count(k => allTags.Any(t => t.Contains(k)));
            if (matches > 0)
            {
                var confidence = Math.Min(0.4 + (matches * 0.2), 0.9);
                categories.Add(new PhotoCategory { Name = stage, Type = "stage", Confidence = confidence });
            }
        }

        return categories.OrderByDescending(c => c.Confidence).Take(5).ToList();
    }

    private string GenerateReadUrl(string container, string blobPath)
    {
        var containerClient = _blobClient.GetBlobContainerClient(container);
        var blobClient = containerClient.GetBlobClient(blobPath);
        
        var sasBuilder = new BlobSasBuilder
        {
            BlobContainerName = container,
            BlobName = blobPath,
            Resource = "b",
            ExpiresOn = DateTimeOffset.UtcNow.AddDays(7)
        };
        sasBuilder.SetPermissions(BlobSasPermissions.Read);
        
        return blobClient.GenerateSasUri(sasBuilder).ToString();
    }

    public async Task<List<Photo>> GetPhotosAsync(string userId, string? status = null, string? search = null)
    {
        // Build base query - CosmosDB doesn't support full-text search, so we'll filter in memory for search
        var query = status != null
            ? new QueryDefinition("SELECT * FROM c WHERE c.uploadedBy = @userId AND c.status = @status ORDER BY c.uploadedAt DESC")
                .WithParameter("@userId", userId)
                .WithParameter("@status", status)
            : new QueryDefinition("SELECT * FROM c WHERE c.uploadedBy = @userId ORDER BY c.uploadedAt DESC")
                .WithParameter("@userId", userId);

        var photos = new List<Photo>();
        using var iterator = _photosContainer.GetItemQueryIterator<Photo>(query);
        while (iterator.HasMoreResults)
        {
            var response = await iterator.ReadNextAsync();
            photos.AddRange(response);
        }

        // Apply search filter in memory if provided
        if (!string.IsNullOrWhiteSpace(search))
        {
            var searchLower = search.ToLowerInvariant();
            photos = photos.Where(p => MatchesSearch(p, searchLower)).ToList();
        }

        return photos;
    }

    private bool MatchesSearch(Photo photo, string searchLower)
    {
        // Search in file name
        if (photo.FileName?.ToLowerInvariant().Contains(searchLower) == true)
            return true;

        // Search in categories (e.g., "kitchen", "bathroom")
        if (photo.Categories?.Any(c => c.Name?.ToLowerInvariant().Contains(searchLower) == true) == true)
            return true;

        // Search in AI caption
        if (photo.AiAnalysis?.Caption?.ToLowerInvariant().Contains(searchLower) == true)
            return true;

        // Search in AI tags
        if (photo.AiAnalysis?.Tags?.Any(t => t.Name?.ToLowerInvariant().Contains(searchLower) == true) == true)
            return true;

        // Search in AI detected objects
        if (photo.AiAnalysis?.Objects?.Any(o => o?.ToLowerInvariant().Contains(searchLower) == true) == true)
            return true;

        return false;
    }

    public async Task<Photo?> GetPhotoAsync(string photoId, string userId)
    {
        try
        {
            var response = await _photosContainer.ReadItemAsync<Photo>(photoId, new PartitionKey(userId));
            return response.Resource;
        }
        catch (CosmosException ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task<Photo?> UpdateCategoriesAsync(string photoId, string userId, List<PhotoCategory> categories)
    {
        var photo = await GetPhotoAsync(photoId, userId);
        if (photo == null) return null;

        photo.Categories = categories;
        photo.Status = "classified";
        photo.ManuallyClassified = true;
        
        await _photosContainer.ReplaceItemAsync(photo, photoId, new PartitionKey(userId));
        return photo;
    }

    public async Task DeletePhotoAsync(string photoId, string userId)
    {
        var photo = await GetPhotoAsync(photoId, userId);
        if (photo == null) return;

        // Delete blobs
        var photosContainer = _blobClient.GetBlobContainerClient("photos");
        await photosContainer.GetBlobClient(photo.BlobPath).DeleteIfExistsAsync();
        
        if (!string.IsNullOrEmpty(photo.ThumbnailBlobPath))
        {
            var thumbContainer = _blobClient.GetBlobContainerClient("thumbnails");
            await thumbContainer.GetBlobClient(photo.ThumbnailBlobPath).DeleteIfExistsAsync();
        }

        await _photosContainer.DeleteItemAsync<Photo>(photoId, new PartitionKey(userId));
    }

    public async Task<DashboardStats> GetStatsAsync(string userId)
    {
        var photos = await GetPhotosAsync(userId);
        return new DashboardStats
        {
            TotalPhotos = photos.Count,
            PendingReview = photos.Count(p => p.Status == "needs_review"),
            Classified = photos.Count(p => p.Status == "classified"),
            ByRoom = photos.SelectMany(p => p.Categories ?? new())
                          .Where(c => c.Type == "room")
                          .GroupBy(c => c.Name)
                          .ToDictionary(g => g.Key, g => g.Count()),
            RecentPhotos = photos.Take(6).ToList()
        };
    }

    // Album methods
    public async Task<Album> CreateAlbumAsync(string name, string? description, string userId)
    {
        var album = new Album
        {
            Id = Guid.NewGuid().ToString(),
            Name = name,
            Description = description,
            CreatedBy = userId,
            CreatedAt = DateTime.UtcNow,
            PhotoIds = new List<string>()
        };
        await _albumsContainer.CreateItemAsync(album, new PartitionKey(userId));
        return album;
    }

    public async Task<List<Album>> GetAlbumsAsync(string userId)
    {
        var query = new QueryDefinition("SELECT * FROM c WHERE c.createdBy = @userId ORDER BY c.createdAt DESC")
            .WithParameter("@userId", userId);

        var albums = new List<Album>();
        using var iterator = _albumsContainer.GetItemQueryIterator<Album>(query);
        while (iterator.HasMoreResults)
        {
            var response = await iterator.ReadNextAsync();
            albums.AddRange(response);
        }
        return albums;
    }

    public async Task<Album?> AddPhotosToAlbumAsync(string albumId, string userId, List<string> photoIds)
    {
        try
        {
            var response = await _albumsContainer.ReadItemAsync<Album>(albumId, new PartitionKey(userId));
            var album = response.Resource;
            
            album.PhotoIds = album.PhotoIds.Union(photoIds).ToList();
            await _albumsContainer.ReplaceItemAsync(album, albumId, new PartitionKey(userId));
            return album;
        }
        catch (CosmosException)
        {
            return null;
        }
    }
}

// Models
public class Photo
{
    [Newtonsoft.Json.JsonProperty("id")]
    public string Id { get; set; } = "";
    [Newtonsoft.Json.JsonProperty("userId")]
    public string UserId { get; set; } = "default";
    [Newtonsoft.Json.JsonProperty("fileName")]
    public string FileName { get; set; } = "";
    [Newtonsoft.Json.JsonProperty("blobPath")]
    public string BlobPath { get; set; } = "";
    [Newtonsoft.Json.JsonProperty("thumbnailBlobPath")]
    public string? ThumbnailBlobPath { get; set; }
    [Newtonsoft.Json.JsonProperty("thumbnailUrl")]
    public string? ThumbnailUrl { get; set; }
    [Newtonsoft.Json.JsonProperty("imageUrl")]
    public string? ImageUrl { get; set; }
    [Newtonsoft.Json.JsonProperty("uploadedBy")]
    public string UploadedBy { get; set; } = "default";
    [Newtonsoft.Json.JsonProperty("uploadedAt")]
    public DateTime UploadedAt { get; set; }
    [Newtonsoft.Json.JsonProperty("status")]
    public string Status { get; set; } = "pending";
    [Newtonsoft.Json.JsonProperty("categories")]
    public List<PhotoCategory>? Categories { get; set; }
    [Newtonsoft.Json.JsonProperty("manuallyClassified")]
    public bool ManuallyClassified { get; set; }
    [Newtonsoft.Json.JsonProperty("exif")]
    public ExifData? Exif { get; set; }
    [Newtonsoft.Json.JsonProperty("aiAnalysis")]
    public AiAnalysisResult? AiAnalysis { get; set; }
}

public class PhotoCategory
{
    public string Name { get; set; } = "";
    public string Type { get; set; } = "";
    public double Confidence { get; set; }
}

public class ExifData
{
    public DateTime? DateTaken { get; set; }
    public string? CameraModel { get; set; }
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }
}

public class AiAnalysisResult
{
    public string? Caption { get; set; }
    public double CaptionConfidence { get; set; }
    public List<AiTag> Tags { get; set; } = new();
    public List<string> Objects { get; set; } = new();
}

public class AiTag
{
    public string Name { get; set; } = "";
    public double Confidence { get; set; }
}

public class Album
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Description { get; set; }
    public string CreatedBy { get; set; } = "default";
    public DateTime CreatedAt { get; set; }
    public List<string> PhotoIds { get; set; } = new();
}

public class DashboardStats
{
    public int TotalPhotos { get; set; }
    public int PendingReview { get; set; }
    public int Classified { get; set; }
    public Dictionary<string, int> ByRoom { get; set; } = new();
    public List<Photo> RecentPhotos { get; set; } = new();
}
