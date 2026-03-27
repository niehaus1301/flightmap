import { useRef, useEffect, useState } from 'react'
import mapboxgl from 'mapbox-gl'

import 'mapbox-gl/dist/mapbox-gl.css';

import AirportMarkerSvg from './assets/airportMarker.svg'
import SpecialFlightCard from './components/SpecialFlightCard'
import { getMarkerImageCandidates } from './utils/specialFlightImages'
import './App.css'

interface SpecialFlightInfo {
  title: string
  description: string
  image: string
  from: string
  to: string
  date: string
}

function App() {

  const mapRef = useRef<mapboxgl.Map | null>(null)
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const [satellite, setSatellite] = useState(false)
  const [specialFlight, setSpecialFlight] = useState<SpecialFlightInfo | null>(null)
  const [cardVisible, setCardVisible] = useState(false)

  useEffect(() => {
    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN
    mapRef.current = new mapboxgl.Map({
      container: mapContainerRef.current!,
      style: import.meta.env.VITE_MAPBOX_STYLE,
    });

    const handleResize = () => mapRef.current?.resize();
    window.addEventListener('resize', handleResize);

    mapRef.current.on('load', () => {
      const map = mapRef.current!;

      requestAnimationFrame(() => {
        map.resize();
      });

      const img = new Image(150, 150);
      img.onload = () => map.addImage('marker', img);
      img.src = AirportMarkerSvg;

      map.addSource('mapbox-satellite', {
        type: 'raster',
        url: 'mapbox://mapbox.satellite',
        tileSize: 256,
      });
      map.addLayer({
        id: 'satellite',
        type: 'raster',
        source: 'mapbox-satellite',
        layout: { visibility: 'none' },
      });

      map.addSource('flightmap', {
        type: 'geojson',
        data: `${import.meta.env.BASE_URL}flightmap.geojson`,
      });

      map.addLayer({
        id: 'routes',
        type: 'line',
        source: 'flightmap',
        filter: ['all',
          ['==', ['get', 'featureType'], 'route'],
          ['!=', ['get', 'isSpecial'], true],
        ],
        paint: {
          'line-color': '#e63946',
          'line-width': 1.5,
          'line-opacity': 0.8,
        },
      });

      map.addLayer({
        id: 'special-routes',
        type: 'line',
        source: 'flightmap',
        filter: ['all',
          ['==', ['get', 'featureType'], 'route'],
          ['==', ['get', 'isSpecial'], true],
        ],
        paint: {
          'line-color': 'green',
          'line-width': 2.5,
          'line-opacity': 1,
        },
      });

      map.addLayer({
        id: 'airports',
        type: 'symbol',
        source: 'flightmap',
        filter: ['==', ['get', 'featureType'], 'airport'],
        layout: {
          'icon-image': 'marker',
          'icon-size': 0.25,
          'icon-anchor': 'bottom',
          'icon-allow-overlap': true,
          'text-field': ['get', 'iata'],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': 'white',
          'text-halo-color': '#000000',
          'text-halo-width': 1,
        }
      });

      // Click handler for special route lines
      map.on('click', 'special-routes', (e) => {
        const props = e.features?.[0]?.properties;
        if (!props) return;
        setSpecialFlight({
          title: props.specialTitle,
          description: props.specialDescription,
          image: props.specialImage,
          from: props.from,
          to: props.to,
          date: props.date,
        });
        setTimeout(() => setCardVisible(true), 10);
      });

      // Cursor pointer on hover for special routes
      map.on('mouseenter', 'special-routes', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'special-routes', () => { map.getCanvas().style.cursor = ''; });

      // Load special marker images, then add the symbol layer
      fetch(`${import.meta.env.BASE_URL}flightmap.geojson`)
        .then(r => r.json())
        .then(async (geojson: GeoJSON.FeatureCollection) => {
          const specialFeatures = geojson.features.filter(
            f => f.properties?.featureType === 'special-marker'
          );

          // Render each special flight's photo as a circular pin icon on a canvas
          for (const feature of specialFeatures) {
            const props = feature.properties!;
            const imageId = `special-pin-${props.flightId}`;
            const size = 128;
            const border = 6;
            const tailH = 20;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size + tailH;
            const ctx = canvas.getContext('2d')!;

            // Draw the pin tail
            const cx = size / 2;
            ctx.beginPath();
            ctx.moveTo(cx - 10, size - 4);
            ctx.lineTo(cx, size + tailH);
            ctx.lineTo(cx + 10, size - 4);
            ctx.fillStyle = '#fff';
            ctx.fill();

            // Draw white border circle
            ctx.beginPath();
            ctx.arc(cx, cx, cx, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();

            // Load and clip photo into circle
            try {
              const loadPhoto = (source: string) => new Promise<HTMLImageElement>((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = `${import.meta.env.BASE_URL}${source}`;
              });

              const candidates = getMarkerImageCandidates(props.image as string);
              let photo: HTMLImageElement | null = null;

              for (const candidate of candidates) {
                try {
                  photo = await loadPhoto(candidate);
                  break;
                } catch {
                  // Try the next candidate format.
                }
              }

              if (!photo) {
                throw new Error('No special marker image candidate could be loaded');
              }

              ctx.save();
              ctx.beginPath();
              ctx.arc(cx, cx, cx - border, 0, Math.PI * 2);
              ctx.clip();
              // Cover-fit the image into the circle
              const imgSize = Math.min(photo.width, photo.height);
              const sx = (photo.width - imgSize) / 2;
              const sy = (photo.height - imgSize) / 2;
              ctx.drawImage(photo, sx, sy, imgSize, imgSize, border, border, size - border * 2, size - border * 2);
              ctx.restore();
            } catch {
              // Fallback: fill with a color if image fails to load
              ctx.save();
              ctx.beginPath();
              ctx.arc(cx, cx, cx - border, 0, Math.PI * 2);
              ctx.fillStyle = '#f5a623';
              ctx.fill();
              ctx.restore();
            }

            map.addImage(imageId, ctx.getImageData(0, 0, canvas.width, canvas.height), {
              pixelRatio: 2,
            });
          }

          // Add the symbol layer once all images are registered
          if (specialFeatures.length > 0) {
            map.addLayer({
              id: 'special-markers',
              type: 'symbol',
              source: 'flightmap',
              filter: ['==', ['get', 'featureType'], 'special-marker'],
              layout: {
                'icon-image': ['concat', 'special-pin-', ['get', 'flightId']],
                'icon-size': 0.8,
                'icon-anchor': 'bottom',
                'icon-allow-overlap': true,
              },
            });

            map.on('click', 'special-markers', (e) => {
              const props = e.features?.[0]?.properties;
              if (!props) return;
              setSpecialFlight({
                title: props.title,
                description: props.description,
                image: props.image,
                from: props.from,
                to: props.to,
                date: props.date,
              });
              setTimeout(() => setCardVisible(true), 10);
            });
            map.on('mouseenter', 'special-markers', () => { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', 'special-markers', () => { map.getCanvas().style.cursor = ''; });
          }
        });
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      mapRef.current?.remove()
    }
  }, [])

  const toggleSatellite = () => {
    const next = !satellite;
    mapRef.current?.setLayoutProperty('satellite', 'visibility', next ? 'visible' : 'none');
    mapRef.current?.setPaintProperty('routes', 'line-color', next ? 'yellow' : '#e63946');
    mapRef.current?.setPaintProperty('special-routes', 'line-color', next ? '#ffd700' : '#f5a623');
    setSatellite(next);
  };

  const closeCard = () => {
    setCardVisible(false);
    setTimeout(() => setSpecialFlight(null), 350);
  };

  return (
    <>
      <div id='map-container' ref={mapContainerRef}/>
      <button className='satellite-toggle' onClick={toggleSatellite}>
        {satellite ? 'Map' : 'Satellite'}
      </button>
      {specialFlight && (
        <SpecialFlightCard
          {...specialFlight}
          onClose={closeCard}
          visible={cardVisible}
        />
      )}
    </>
  )
}

export default App